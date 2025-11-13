// whatsapp/chatbot/conversa_flow.js
import fs from "fs";
import path from "path";
import { Pool } from "pg";

function onlyDigits(s = "") { return (s || "").replace(/\D/g, ""); }
function jidToPhone(jid = "") { return onlyDigits(String(jid).split("@")[0]); }
function strip(s = "") { return String(s || "").trim(); }
function norm(s = "") {
  return strip(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// ---- dias da semana ----
function parseDiasLista(txt = "") {
  const map = {
    "seg": 1, "segunda": 1, "segunda-feira": 1,
    "ter": 2, "terca": 2, "terça": 2, "terça-feira": 2,
    "qua": 3, "quarta": 3, "quarta-feira": 3,
    "qui": 4, "quinta": 4, "quinta-feira": 4,
    "sex": 5, "sexta": 5, "sexta-feira": 5,
  };
  const itens = norm(txt).split(/[,\s;/]+/).filter(Boolean);
  const dias = new Set();
  for (const it of itens) if (map[it] != null) dias.add(map[it]);
  return [...dias].sort((a, b) => a - b);
}

function diasHumanos(dias = []) {
  const mapInv = { 1: "Seg", 2: "Ter", 3: "Qua", 4: "Qui", 5: "Sex", 6: "Sáb", 7: "Dom" };
  return (dias || []).map(d => mapInv[d] || d).join(", ");
}

// ---- datas / cutoff 13:15 ----
const DIA_LONGO = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];

function ddmm(d) {
  const x = new Date(d);
  const dd = String(x.getDate()).padStart(2, "0");
  const mm = String(x.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}`;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function cutoff1315(dt) {
  const x = new Date(dt);
  x.setHours(13, 15, 0, 0);
  return x;
}

function diaCancelamentoAlvo(now = new Date()) {
  // <= 13:15 → hoje; > 13:15 → amanhã
  return (now <= cutoff1315(now)) ? now : addDays(now, 1);
}

// ---- header / identidade visual ----
function header(aluno) {
  const titulo = "IFSP Pirituba | Assistente de Almoço\n";
  if (!aluno) {
    return (
      titulo +
      "Você está falando com o robô que ajuda no sistema de pedidos de almoço do câmpus.\n" +
      "--------------------------------\n"
    );
  }
  const pront = aluno.prontuario || "não informado";
  const nome = aluno.nome || "Aluno";
  return (
    titulo +
    `Aluno: ${nome}\n` +
    `Prontuário: ${pront}\n` +
    "--------------------------------\n"
  );
}

export function createConversaFlow({ dataDir = "/app/data", dbUrl, logger = console }) {
  // --------- estado em arquivo ----------
  const STORE_FILE = path.join(dataDir, "conversa_flow_state.json");
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")); } catch { state = {}; }

  function saveState() {
    try { fs.writeFileSync(STORE_FILE, JSON.stringify(state)); } catch { }
  }

  function getUser(jid) {
    return state[jid] || (state[jid] = { step: "NEW", temp: {} });
  }

  function setUser(jid, patch) {
    state[jid] = { ...(state[jid] || { step: "NEW", temp: {} }), ...patch };
    saveState();
  }

  // --------- DB ----------
  if (!dbUrl) throw new Error("DATABASE_URL vazio. Defina env DATABASE_URL.");
  const pool = new Pool({
    connectionString: dbUrl,
    max: 5,
    idleTimeoutMillis: 30_000
  });

  async function withConn(fn) {
    const c = await pool.connect();
    try { return await fn(c); } finally { c.release(); }
  }

  async function findAlunoByTelefone(c, telefone) {
    const q = `
      SELECT a.*
      FROM aluno a
      JOIN contato ctt ON ctt.aluno_id = a.id
      WHERE ctt.telefone = $1
      LIMIT 1`;
    const { rows } = await c.query(q, [telefone]);
    return rows[0] || null;
  }

  async function createAlunoComContato(c, { nome, prontuario, telefone }) {
    const a = await c.query(
      `INSERT INTO aluno (nome, prontuario, ativo) VALUES ($1,$2,true) RETURNING id`,
      [nome, prontuario]
    );
    const alunoId = a.rows[0].id;
    await c.query(
      `INSERT INTO contato (aluno_id, telefone) VALUES ($1,$2)`,
      [alunoId, telefone]
    );
    return alunoId;
  }

  async function setPreferenciasDias(c, alunoId, dias = []) {
    await c.query(`DELETE FROM preferencia_dia WHERE aluno_id=$1`, [alunoId]);
    if (!dias.length) return;
    const values = dias.map((d, i) => `($1,$${i + 2})`).join(",");
    await c.query(
      `INSERT INTO preferencia_dia (aluno_id, dia_semana) VALUES ${values}`,
      [alunoId, ...dias]
    );
  }

  async function addBloqueios(c, alunoId, nomes = []) {
    for (const nome of nomes.map(strip).filter(Boolean)) {
      await c.query(
        `INSERT INTO prato_bloqueado (aluno_id, nome)
         SELECT $1, $2
         WHERE NOT EXISTS (
           SELECT 1 FROM prato_bloqueado
           WHERE aluno_id=$1 AND lower(nome)=lower($2)
         )`,
        [alunoId, nome]
      );
    }
  }

  async function setAtivo(c, alunoId, ativo) {
    await c.query(`UPDATE aluno SET ativo=$2 WHERE id=$1`, [alunoId, !!ativo]);
  }

  // --------- textos de apoio ----------
  function helpText(aluno) {
    return (
      header(aluno) +
      "Menu principal\n\n" +
      "• *Cancelar*  → registrar cancelamento de almoço\n" +
      "• *Preferência*  → escolher dias em que você costuma almoçar no câmpus\n" +
      "• *Bloquear*  → informar pratos que você não come / quer evitar\n" +
      "• *Ativar* / *Desativar*  → ligar ou pausar seu cadastro\n" +
      "• *Status*  → ver seus dados no sistema\n\n" +
      "Para ver esse menu de novo, envie: *Ajuda*."
    );
  }

  const ONBOARDING =
    header(null) +
    "Eu ajudo a registrar cancelamento de almoço e preferências (dias e pratos)\n" +
    "no sistema de pedidos de almoço do câmpus Pirituba.\n\n" +
    "Pra começar o cadastro, envie: *CONTINUAR*.\n" +
    "Se não quiser agora, pode voltar a qualquer momento enviando *Ajuda*.";

  // --------- handler principal ----------
  async function handleText(jid, textRaw) {
    const text = strip(textRaw);
    if (!text) return null;

    const u = getUser(jid);
    const phone = jidToPhone(jid);

    const aluno = await withConn(c => findAlunoByTelefone(c, phone));
    if (aluno && !u.aluno_id) {
      setUser(jid, { aluno_id: aluno.id, step: "MAIN", temp: {} });
    }

    const n = norm(text);

    // atalhos globais
    if (["ajuda", "menu", "help", "comandos"].includes(n)) {
      setUser(jid, { step: "MAIN", temp: {} });
      return helpText(aluno || null);
    }

    if (n === "status" || n === "meu status" || n === "cadastro") {
      if (!aluno) {
        return (
          header(null) +
          "Seu número ainda *não está vinculado* a nenhum cadastro de aluno no sistema de almoço do IFSP Pirituba.\n\n" +
          "Pra começar o cadastro, envie: *CONTINUAR*."
        );
      }
      return (
        header(aluno) +
        "*Status do seu cadastro*\n\n" +
        `• Nome: *${aluno.nome || "não informado"}*\n` +
        `• Prontuário: *${aluno.prontuario || "não informado"}*\n` +
        `• Cadastro ativo: *${aluno.ativo ? "Sim" : "Não"}*\n\n` +
        "Envie *Ajuda* para ver o menu de comandos."
      );
    }

    // ================= cadastro (ainda não existe no banco) =================
    if (!aluno) {
      // fast-forward do consentimento
      if (["sim", "s", "ok", "yes", "continuar"].includes(n)) {
        setUser(jid, { step: "ASK_NOME", temp: {} });
        return (
          header(null) +
          "*Cadastro de aluno – IFSP Pirituba*\n\n" +
          "Como devo te chamar?\n" +
          "Envie seu *nome completo* como está no IFSP."
        );
      }

      if (u.step === "NEW") {
        setUser(jid, { step: "ASK_CONSENT", temp: {} });
        return ONBOARDING;
      }

      if (u.step === "ASK_CONSENT") {
        return (
          header(null) +
          "Tranquilo, sem problemas.\n\n" +
          "Quando você quiser usar o sistema automático de pedidos de almoço do IFSP Pirituba,\n" +
          "basta responder *CONTINUAR*."
        );
      }

      if (u.step === "ASK_NOME") {
        if (text.length < 2) {
          return (
            header(null) +
            "Nome muito curto.\n" +
            "Envie seu *nome completo* como está no cadastro do IFSP."
          );
        }
        setUser(jid, { step: "ASK_PRONT", temp: { ...u.temp, nome: strip(text) } });
        return (
          header(null) +
          "*Nome recebido!*\n\n" +
          "Agora envie seu *prontuário IFSP* (ex.: *3029701* ou *3X028702*).\n" +
          "Aceitamos de 5 a 12 caracteres com letras e números."
        );
      }

      if (u.step === "ASK_PRONT") {
        const pront = strip(text).toUpperCase().replace(/\s+/g, "");
        if (!/^[A-Z0-9]{5,12}$/.test(pront)) {
          return (
            header(null) +
            "*Formato de prontuário inválido.*\n\n" +
            "Envie algo como *3029701* ou *3X028702*.\n" +
            "Use apenas letras e números (5 a 12 caracteres)."
          );
        }
        setUser(jid, { step: "ASK_DIAS_REG", temp: { ...u.temp, prontuario: pront } });
        return (
          header(null) +
          "*Prontuário registrado!*\n\n" +
          "Pra finalizar seu cadastro no sistema automático de pedidos do IFSP Pirituba:\n" +
          "quais dias você *costuma almoçar* no câmpus?\n\n" +
          "Envie algo como: *seg, ter, qua, qui, sex*."
        );
      }

      if (u.step === "ASK_DIAS_REG") {
        const dias = parseDiasLista(text);
        if (!dias.length) {
          return (
            header(null) +
            "Não entendi os dias.\n\n" +
            "Exemplos válidos: *seg, qua, sex* ou *segunda, terça, quinta*."
          );
        }

        const alunoId = await withConn(async c => {
          const id = await createAlunoComContato(c, {
            nome: u.temp.nome,
            prontuario: u.temp.prontuario,
            telefone: phone
          });
          await setPreferenciasDias(c, id, dias);
          return id;
        });

        setUser(jid, { step: "MAIN", temp: {}, aluno_id: alunoId });

        const alunoFake = {
          nome: u.temp.nome,
          prontuario: u.temp.prontuario,
          ativo: true
        };

        return (
          header(alunoFake) +
          "*Cadastro concluído no sistema automático de pedidos (IFSP Pirituba).* \n\n" +
          `Dias preferidos registrados: *${diasHumanos(dias)}*.\n\n` +
          "A partir de agora, você pode:\n" +
          "• Enviar *Cancelar* para registrar pedido de cancelamento de almoço.\n" +
          "• Enviar *Preferência* para alterar os dias.\n" +
          "• Enviar *Bloquear* para registrar pratos que não come.\n\n" +
          "Envie *Ajuda* para ver o menu completo."
        );
      }

      // fallback enquanto não cadastrado
      return ONBOARDING;
    }

    // ================= aluno já conhecido =================
    const alunoAtual = aluno;

    if (u.step === "SET_DIAS") {
      const dias = parseDiasLista(text);
      if (!dias.length) {
        return (
          header(alunoAtual) +
          "Não entendi os dias.\n\n" +
          "Envie algo como: *seg, qua, sex* ou *segunda, terça, quinta*."
        );
      }
      await withConn(c => setPreferenciasDias(c, alunoAtual.id, dias));
      setUser(jid, { step: "MAIN", temp: {} });
      return (
        header(alunoAtual) +
        "*Preferências de dias atualizadas!*\n\n" +
        `Dias cadastrados para o refeitório do câmpus Pirituba: *${diasHumanos(dias)}*.\n\n` +
        "Envie *Ajuda* para voltar ao menu."
      );
    }

    if (u.step === "SET_BLOQ") {
      const itens = text.split(/[,;\n]+/).map(strip).filter(Boolean);
      if (!itens.length) {
        return (
          header(alunoAtual) +
          "Não encontrei nenhum prato na sua mensagem.\n\n" +
          "Envie os *pratos* que deseja bloquear, separados por vírgula.\n" +
          "Ex.: *carne moída, estrogonofe*."
        );
      }
      await withConn(c => addBloqueios(c, alunoAtual.id, itens));
      setUser(jid, { step: "MAIN", temp: {} });
      return (
        header(alunoAtual) +
        "*Bloqueios salvos!*\n\n" +
        `Pratos bloqueados: *${itens.join(", ")}*.\n\n` +
        "Essas informações serão usadas quando formos montar seus pedidos\n" +
        "no sistema automático de almoço do IFSP Pirituba.\n\n" +
        "Envie *Ajuda* para voltar ao menu."
      );
    }

    if (u.step === "CONFIRM_CANCEL") {
      const d = new Date(u.temp?.cancelDate || new Date());
      const alvo = `${DIA_LONGO[d.getDay()]} ${ddmm(d)}`;

      if (["sim", "s", "ok", "yes", "confirmar", "confirmo"].includes(n)) {
        setUser(jid, { step: "MAIN", temp: {} });
        return (
          header(alunoAtual) +
          "*Pedido de cancelamento registrado.*\n\n" +
          `Almoço de *${alvo}* marcado para cancelamento junto à CAE do IFSP Pirituba,\n` +
          `usando o seu prontuário *${alunoAtual.prontuario}*.\n\n` +
          "Guarde esta mensagem como comprovante.\n" +
          "Envie *Status* para ver seus dados ou *Ajuda* para o menu."
        );
      }

      if (["nao", "não", "n", "cancelar", "voltar", "parar"].includes(n)) {
        setUser(jid, { step: "MAIN", temp: {} });
        return (
          header(alunoAtual) +
          "Beleza, não vou registrar nenhum cancelamento agora.\n\n" +
          "Se quiser cancelar depois, envie *Cancelar*.\n" +
          "Envie *Ajuda* para ver as opções."
        );
      }

      // se mandou algo aleatório, repete a confirmação
      return (
        header(alunoAtual) +
        "Só pra confirmar:\n\n" +
        `Você deseja que eu registre o *cancelamento do almoço de ${alvo}* ` +
        `na CAE do IFSP Pirituba usando o seu prontuário *${alunoAtual.prontuario}*?\n\n` +
        "Responda *SIM* para confirmar ou *NÃO* para voltar."
      );
    }

    // intenções principais
    if (
      n.startsWith("cancelar") ||
      n === "nao vou" ||
      n === "nao vou almocar" ||
      n === "não vou" ||
      n === "não vou almoçar"
    ) {
      const alvoDate = diaCancelamentoAlvo(new Date());
      const alvo = `${DIA_LONGO[alvoDate.getDay()]} ${ddmm(alvoDate)}`;
      setUser(jid, { step: "CONFIRM_CANCEL", temp: { cancelDate: alvoDate } });

      return (
        header(alunoAtual) +
        "Cancelamento de almoço\n\n" +
        "Regras da CAE (almoço):\n" +
        "• Até *13:15*: cancela o almoço de *hoje*.\n" +
        "• Depois de *13:15*: cancela o almoço de *amanhã*.\n\n" +
        `Pela hora atual, o alvo é: *${alvo}*.\n\n` +
        `Confirmar cancelamento desse almoço usando seu prontuário *${alunoAtual.prontuario}*?\n\n` +
        "Responda *SIM* para confirmar ou *NÃO* para voltar."
      );
    }

    if (
      n.startsWith("preferencia") ||
      n === "preferencias" ||
      n === "dia" ||
      n === "dias"
    ) {
      setUser(jid, { step: "SET_DIAS", temp: {} });
      return (
        header(alunoAtual) +
        "Atualizar dias em que você costuma almoçar\n\n" +
        "Envie os dias da semana que normalmente você almoça no câmpus.\n" +
        "Exemplos: *seg, ter, qua, qui, sex* ou *segunda, terça, quinta*."
      );
    }

    if (
      n.startsWith("bloquear") ||
      n.includes("nao como") ||
      n.includes("não como") ||
      n.includes("alergia")
    ) {
      setUser(jid, { step: "SET_BLOQ", temp: {} });
      return (
        header(alunoAtual) +
        "Bloquear pratos no sistema\n\n" +
        "Envie os *pratos* que você não come / tem alergia / prefere evitar,\n" +
        "separados por vírgula. Ex.: *frango xadrez, feijoada*."
      );
    }

    if (n === "ativar") {
      await withConn(c => setAtivo(c, alunoAtual.id, true));
      return (
        header({ ...alunoAtual, ativo: true }) +
        "Seu cadastro no sistema automático de almoço do IFSP Pirituba foi *ativado*.\n\n" +
        "Você continuará recebendo as ações com base nas suas preferências.\n" +
        "Envie *Ajuda* para ver o menu."
      );
    }

    if (n === "desativar" || n === "pausar") {
      await withConn(c => setAtivo(c, alunoAtual.id, false));
      return (
        header({ ...alunoAtual, ativo: false }) +
        "Seu cadastro no sistema automático de almoço do IFSP Pirituba foi *desativado*.\n\n" +
        "Você pode enviar *Ativar* quando quiser voltar.\n" +
        "Envie *Ajuda* para ver o menu."
      );
    }

    if (n === "cadastrar") {
      return (
        header(alunoAtual) +
        "Seu número já está *cadastrado* no sistema de almoço do IFSP Pirituba.\n\n" +
        "Envie *Ajuda* para ver o menu de comandos."
      );
    }

    // fallback padrão
    return (
      header(alunoAtual) +
      "Não entendi sua mensagem.\n\n" +
      "Envie *Ajuda* pra ver o menu de opções do assistente de almoço do IFSP Pirituba."
    );
  }

  async function close() {
    try { await pool.end(); } catch { }
  }

  return { handleText, close };
}
