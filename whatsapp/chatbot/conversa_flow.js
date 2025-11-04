// whatsapp/chatbot/conversa_flow.js
import fs from "fs";
import path from "path";
import { Pool } from "pg";

function onlyDigits(s = "") { return (s || "").replace(/\D/g, ""); }
function jidToPhone(jid = "") { return onlyDigits(String(jid).split("@")[0]); }
function strip(s = "") { return String(s || "").trim(); }
function norm(s = "") {
  return strip(s).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function parseDiasLista(txt = "") {
  const map = {
    "seg":1,"segunda":1,"segunda-feira":1,
    "ter":2,"terca":2,"terça":2,"terça-feira":2,
    "qua":3,"quarta":3,"quarta-feira":3,
    "qui":4,"quinta":4,"quinta-feira":4,
    "sex":5,"sexta":5,"sexta-feira":5,
  };
  const itens = norm(txt).split(/[,\s;/]+/).filter(Boolean);
  const dias = new Set();
  for (const it of itens) if (map[it] != null) dias.add(map[it]);
  return [...dias].sort((a,b)=>a-b);
}
function diasHumanos(dias = []) {
  const mapInv = {1:"Seg",2:"Ter",3:"Qua",4:"Qui",5:"Sex",6:"Sáb",7:"Dom"};
  return (dias || []).map(d => mapInv[d] || d).join(", ");
}

export function createConversaFlow({ dataDir = "/app/data", dbUrl, logger = console }) {
  // --------- estado simples em arquivo ----------
  const STORE_FILE = path.join(dataDir, "conversa_flow_state.json");
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")); } catch { state = {}; }
  function saveState() { try { fs.writeFileSync(STORE_FILE, JSON.stringify(state)); } catch {} }
  function getUser(jid) { return state[jid] || (state[jid] = { step: "NEW", temp: {} }); }
  function setUser(jid, patch) {
    state[jid] = { ...(state[jid] || { step:"NEW", temp:{} }), ...patch };
    saveState();
  }

  // --------- DB ----------
  if (!dbUrl) throw new Error("DATABASE_URL vazio. Defina env DATABASE_URL.");
  const pool = new Pool({ connectionString: dbUrl, max: 5, idleTimeoutMillis: 30_000 });
  async function withConn(fn){ const c = await pool.connect(); try { return await fn(c); } finally { c.release(); } }

  async function findAlunoByTelefone(c, telefone){
    const q = `
      SELECT a.*
      FROM aluno a
      JOIN contato ctt ON ctt.aluno_id = a.id
      WHERE ctt.telefone = $1
      LIMIT 1`;
    const { rows } = await c.query(q, [telefone]);
    return rows[0] || null;
  }
  async function createAlunoComContato(c, { nome, prontuario, telefone }){
    const a = await c.query(`INSERT INTO aluno (nome, prontuario, ativo) VALUES ($1,$2,true) RETURNING id`, [nome, prontuario]);
    const alunoId = a.rows[0].id;
    await c.query(`INSERT INTO contato (aluno_id, telefone) VALUES ($1,$2)`, [alunoId, telefone]);
    return alunoId;
  }
  async function setPreferenciasDias(c, alunoId, dias = []){
    await c.query(`DELETE FROM preferencia_dia WHERE aluno_id=$1`, [alunoId]);
    if (!dias.length) return;
    const values = dias.map((d,i)=>`($1,$${i+2})`).join(",");
    await c.query(`INSERT INTO preferencia_dia (aluno_id, dia_semana) VALUES ${values}`, [alunoId, ...dias]);
  }
  async function addBloqueios(c, alunoId, nomes = []){
    for (const nome of nomes.map(strip).filter(Boolean)) {
      await c.query(
        `INSERT INTO prato_bloqueado (aluno_id, nome)
         SELECT $1, $2
         WHERE NOT EXISTS (
           SELECT 1 FROM prato_bloqueado WHERE aluno_id=$1 AND lower(nome)=lower($2)
         )`,
        [alunoId, nome]
      );
    }
  }
  async function setAtivo(c, alunoId, ativo){
    await c.query(`UPDATE aluno SET ativo=$2 WHERE id=$1`, [alunoId, !!ativo]);
  }

  // --------- textos ----------
  const helpText =
    "Comandos:\n" +
    "• *Cancelar* – marcar que você não vai almoçar hoje (por enquanto só confirmamos).\n" +
    "• *Preferência* – escolher dias da semana (seg…sex).\n" +
    "• *Bloquear* – informar pratos que você não come.\n" +
    "• *Ativar* / *Desativar* – ligar/desligar seu cadastro.\n" +
    "• *Ajuda* – ver este menu.";

  // onboarding pedido (mantive sua redação)
  const ONBOARDING = 
    "Oi! Eu sou o robô que vai te ajudar a pedir seu almoço de forma automática. " +
    "Se quiser começar, envie *CONTINUAR* e eu vou te cadastrar rapidinho. " +
    "Depois disso, você poderá me dizer seus dias preferidos, horários e outras preferências!";

  // --------- handler principal ----------
  async function handleText(jid, textRaw) {
    const text = strip(textRaw);
    if (!text) return null;

    const u = getUser(jid);
    const phone = jidToPhone(jid);
    const aluno = await withConn(c => findAlunoByTelefone(c, phone));
    if (aluno && !u.aluno_id) setUser(jid, { aluno_id: aluno.id, step: "MAIN", temp: {} });

    const n = norm(text);

    // atalhos globais
    if (["ajuda","menu","help","comandos"].includes(n)) {
      setUser(jid, { step: "MAIN", temp: {} });
      return "✅ Aqui está o menu:\n" + helpText;
    }

    // ================= cadastro (quando AINDA não existe no banco) =================
    if (!aluno) {
      // **FAST-FORWARD DO CONSENTIMENTO** (evita loop mesmo se step voltar pra NEW)
      if (["sim","s","ok","yes","continuar"].includes(n)) {
        setUser(jid, { step: "ASK_NOME", temp: {} });
        return "Perfeito! Como devo te chamar? (envie seu *nome completo*).";
        // (daqui pra frente fluxo normal segue)
      }

      if (u.step === "NEW") {
        setUser(jid, { step: "ASK_CONSENT", temp: {} });
        return ONBOARDING;
      }
      if (u.step === "ASK_CONSENT") {
        // se não mandou CONTINUAR/consentimento, reforça a instrução
        return "Sem problemas. Quando quiser começar, responda *CONTINUAR*.";
      }
      if (u.step === "ASK_NOME") {
        if (text.length < 2) return "Nome muito curto. Envie seu *nome completo*.";
        setUser(jid, { step: "ASK_PRONT", temp: { ...u.temp, nome: strip(text) } });
        return "Agora envie seu *prontuário* (ex.: IFSP123456).";
      }
      if (u.step === "ASK_PRONT") {
        const pront = strip(text).toUpperCase();
        if (pront.length < 4) return "Formato de prontuário estranho. Envie algo como *IFSP123456*.";
        const alunoId = await withConn(c => createAlunoComContato(c, {
          nome: u.temp.nome, prontuario: pront, telefone: phone
        }));
        setUser(jid, { step: "MAIN", temp: {}, aluno_id: alunoId });
        return "✅ Cadastro concluído!\nSeu número foi salvo no sistema.\n\n" + helpText;
      }
      // fallback para novos
      return ONBOARDING;
    }

    // ================= aluno já conhecido =================
    if (u.step === "SET_DIAS") {
      const dias = parseDiasLista(text);
      if (!dias.length) return "Não entendi os dias. Envie algo como: *seg, qua, sex*.";
      await withConn(c => setPreferenciasDias(c, aluno.id, dias));
      setUser(jid, { step: "MAIN", temp: {} });
      return `Preferências atualizadas: ${diasHumanos(dias)} ✅`;
    }
    if (u.step === "SET_BLOQ") {
      const itens = text.split(/[,;\n]+/).map(strip).filter(Boolean);
      if (!itens.length) return "Envie os pratos separados por vírgula (ex.: *carne moída, estrogonofe*).";
      await withConn(c => addBloqueios(c, aluno.id, itens));
      setUser(jid, { step: "MAIN", temp: {} });
      return `Bloqueios salvos: ${itens.join(", ")} ✅`;
    }

    if (n.startsWith("cancelar") || n === "nao vou" || n === "nao vou almocar" || n === "não vou" || n === "não vou almoçar") {
      return "Ok, anotado: hoje você *não pretende almoçar*. Em breve avisaremos a secretaria automaticamente. Digite *Ajuda* para opções.";
    }
    if (n.startsWith("preferencia") || n === "preferencias" || n === "dia" || n === "dias") {
      setUser(jid, { step: "SET_DIAS", temp: {} });
      return "Quais dias você costuma almoçar? Envie *seg, ter, qua, qui, sex* (separe por vírgulas).";
    }
    if (n.startsWith("bloquear") || n.includes("nao como") || n.includes("não como") || n.includes("alergia")) {
      setUser(jid, { step: "SET_BLOQ", temp: {} });
      return "Envie os *pratos* que deseja bloquear, separados por vírgula. Ex.: *frango xadrez, feijoada*";
    }
    if (n === "ativar") { await withConn(c => setAtivo(c, aluno.id, true)); return "Cadastro *ativado* ✅"; }
    if (n === "desativar" || n === "pausar") { await withConn(c => setAtivo(c, aluno.id, false)); return "Cadastro *desativado* (você pode enviar *Ativar* quando quiser voltar)."; }
    if (n === "cadastrar") return "Seu número *já está cadastrado*. Digite *Ajuda* para ver os comandos.";

    return "Não entendi. Digite *Ajuda* para ver os comandos.";
  }

  async function close(){ try { await pool.end(); } catch {} }
  return { handleText, close };
}
