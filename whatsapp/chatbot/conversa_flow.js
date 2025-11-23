import fs from "fs";
import path from "path";
import { Pool } from "pg";
import nodemailer from "nodemailer";

function onlyDigits(s = "") { return (s || "").replace(/\D/g, ""); }
// Extrai apenas os números para usar como chave estável
function jidToPhone(jid = "") { return onlyDigits(String(jid).split("@")[0]); }
function strip(s = "") { return String(s || "").trim(); }
function norm(s = "") {
  return strip(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

// ---- dias da semana ----
const DIAS_SEMANA = ["Domingo", "Segunda-Feira", "Terça-Feira", "Quarta-Feira", "Quinta-Feira", "Sexta-Feira", "Sábado"];

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

function isoDateUTC(d) {
  return new Date(d).toISOString().slice(0, 10);
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
  let target = (now <= cutoff1315(now)) ? now : addDays(now, 1);
  while (target.getDay() === 0 || target.getDay() === 6) {
    target = addDays(target, 1);
  }
  return target;
}

// ---- helpers de data / motivo para pedidos ----
function formatDiaBR(dateLike) {
  if (!dateLike) return "?";
  // Tenta parsing manual YYYY-MM-DD para evitar timezone mess
  const s = String(dateLike);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    return `${m[3]}/${m[2]}`; // DD/MM
  }
  // Fallback Date object
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return s;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}`;
}

function getDiaSemanaNome(dateLike) {
  if (!dateLike) return "";
  const s = String(dateLike);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  let d;
  if (m) {
    // Cria data localmente (ano, mes-1, dia) para garantir dia da semana correto
    d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
  } else {
    d = new Date(dateLike);
  }
  if (Number.isNaN(d.getTime())) return "";
  return DIAS_SEMANA[d.getDay()];
}

function classificaMotivo(motivoRaw = "") {
  const full = String(motivoRaw || "");
  const idx = full.indexOf(":");
  const tag = (idx >= 0 ? full.slice(0, idx) : full).trim();
  const detalhe = idx >= 0 ? full.slice(idx + 1).trim() : "";
  const tagNorm = norm(tag);

  let tipo = "OUTRO";
  if (tagNorm.startsWith("nao_pediu") || tagNorm.startsWith("nao pediu")) {
    tipo = "NAO_PEDIU";
  } else if (tagNorm.startsWith("pediu_ok")) {
    tipo = "PEDIU_OK";
  } else if (tagNorm.startsWith("erro_pedido")) {
    tipo = "ERRO_PEDIDO";
  }

  return { tipo, detalhe, bruto: full };
}

// ---- header / identidade visual NOVO FORMATO ----
function header(aluno, ultimoPedido, pratoAtual) {
  const titulo = "IFSP Pirituba | Assistente de Almoço\n";
  if (!aluno) {
    return titulo +
      "Você está falando com o robô que ajuda no sistema de pedidos de almoço do câmpus.\n" +
      "--------------------------------\n";
  }

  const pront = aluno.prontuario || "não informado";
  const nome = aluno.nome || "Aluno";

  // Linha do Último Pedido
  let linhaPedido = "Último registro de pedido: nenhum registro recente.";
  if (ultimoPedido) {
    const data = formatDiaBR(ultimoPedido.dia_pedido);
    const diaSemana = getDiaSemanaNome(ultimoPedido.dia_pedido);
    const { tipo } = classificaMotivo(ultimoPedido.motivo);
    
    let statusEmoji = "❓";
    if (tipo === "PEDIU_OK") statusEmoji = "✅";
    else if (tipo === "NAO_PEDIU") statusEmoji = "⚠️ (Bloqueio/Pulo)";
    else if (tipo === "ERRO_PEDIDO") statusEmoji = "❌ (Erro)";

    linhaPedido = `Último registro de pedido: ${data} - ${diaSemana} ${statusEmoji}`;
  }

  // Linha do Prato Atual
  let linhaPrato = "Prato Atual: informação indisponível.";
  if (pratoAtual && pratoAtual.prato_nome) {
    const dataPrato = formatDiaBR(pratoAtual.dia_referente);
    linhaPrato = `Prato Atual: ${pratoAtual.prato_nome} (Almoço de ${dataPrato})`;
  }

  return (
    titulo +
    `Aluno: ${nome}\n` +
    `Prontuário: ${pront}\n` +
    `${linhaPedido}\n` +
    `${linhaPrato}\n` +
    "--------------------------------\n"
  );
}

// ---- e-mail de cancelamento (Gmail) ----
const GMAIL_USER = process.env.GMAIL_USER || "";
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD || "";
const CAE_EMAIL = process.env.CAE_EMAIL || GMAIL_USER || "";

let mailTransporter = null;
if (GMAIL_USER && GMAIL_APP_PASSWORD) {
  mailTransporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD,
    },
  });
}

export function createConversaFlow({ dataDir = "/app/data", dbUrl, logger = console }) {
  // --------- estado em arquivo ----------
  const STORE_FILE = path.join(dataDir, "conversa_flow_state.json");
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STORE_FILE, "utf8")); } catch { state = {}; }

  function saveState() {
    try { fs.writeFileSync(STORE_FILE, JSON.stringify(state)); } catch { }
  }

  function getUser(userKey) {
    return state[userKey] || (state[userKey] = { step: "NEW", temp: {} });
  }

  function setUser(userKey, patch) {
    state[userKey] = { ...(state[userKey] || { step: "NEW", temp: {} }), ...patch };
    saveState();
  }

// --- helper para envio de e-mail de cancelamento ---
  async function sendCancelEmail({ aluno, alvoDate, phone }) {
    if (!mailTransporter || !CAE_EMAIL) {
      logger.error("E-mail de cancelamento não configurado.");
      return { ok: false, reason: "NO_TRANSPORT" };
    }

    const dataStr = ddmm(alvoDate);
    const diaSemana = DIA_LONGO[alvoDate.getDay()];
    const nome = aluno.nome || "Aluno";
    const prontBase = String(aluno.prontuario || "").toUpperCase();
    const prontCompleto = prontBase.startsWith("PT") ? prontBase : `PT${prontBase}`;
    const prontNumerico = onlyDigits(prontBase);
    
    const subject = `Cancelamento de almoço - ${prontCompleto} - ${dataStr}`;
    
    const html = `
      <div style="font-family: Arial, sans-serif; color: #333;">
        <h2 style="color: #d9534f;">Solicitação de Cancelamento de Almoço</h2>
        <p><strong>Aluno:</strong> ${nome}</p>
        <p><strong>Prontuário:</strong> ${prontCompleto}</p>
        <div style="background-color: #f8f9fa; border: 1px solid #ddd; padding: 15px; margin: 20px 0; border-radius: 5px;">
          <p style="margin: 0 0 10px;">Para copiar o prontuário:</p>
          <span style="font-size: 24px; font-weight: bold; letter-spacing: 2px; background: #fff; padding: 5px 10px; border: 1px dashed #999;">
            ${prontNumerico}
          </span>
        </div>
        <p><strong>Data a cancelar:</strong> ${diaSemana}, ${dataStr}</p>
        <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
        <p style="font-size: 12px; color: #777;">Mensagem automática.</p>
      </div>
    `;

    const text = `Solicitação de cancelamento:\nAluno: ${nome}\nProntuário: ${prontNumerico}\nData: ${dataStr}`;

    try {
      await mailTransporter.sendMail({
        from: `"Assistente de Almoço IFSP Pirituba" <${GMAIL_USER}>`,
        to: CAE_EMAIL,
        subject,
        text,
        html,
      });
      return { ok: true };
    } catch (err) {
      logger.error("Erro ao enviar e-mail:", err);
      return { ok: false, reason: "SMTP_ERROR", error: String(err) };
    }
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

  async function findAlunoByProntuario(c, prontuario) {
    const q = `SELECT * FROM aluno WHERE prontuario = $1 LIMIT 1`;
    const { rows } = await c.query(q, [prontuario]);
    return rows[0] || null;
  }

  async function ensureAlunoContato(c, { prontuario, telefone }) {
    const aluno = await findAlunoByProntuario(c, prontuario);
    if (!aluno) return { ok: false, reason: "NAO_TURMA" };

    const { rows } = await c.query(
      `SELECT telefone FROM contato WHERE aluno_id = $1 LIMIT 1`, [aluno.id]
    );

    if (rows.length) {
      const telExistente = onlyDigits(rows[0].telefone || "");
      const telNovo = onlyDigits(telefone || "");
      if (telExistente !== telNovo) {
        return { ok: false, reason: "JA_VINCULADO", telefone: telExistente, aluno };
      }
      return { ok: true, alunoId: aluno.id, aluno };
    }

    await c.query(
      `INSERT INTO contato (aluno_id, telefone) VALUES ($1,$2)`, [aluno.id, telefone]
    );
    return { ok: true, alunoId: aluno.id, aluno };
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
          )`, [alunoId, nome]
      );
    }
  }

  async function setAtivo(c, alunoId, ativo) {
    await c.query(`UPDATE aluno SET ativo=$2 WHERE id=$1`, [alunoId, !!ativo]);
  }

  async function getPreferenciasDias(c, alunoId) {
    const { rows } = await c.query(
      `SELECT dia_semana FROM preferencia_dia WHERE aluno_id = $1 ORDER BY dia_semana`, [alunoId]
    );
    return rows.map(r => r.dia_semana);
  }

  async function getBloqueiosAluno(c, alunoId) {
    const { rows } = await c.query(
      `SELECT nome FROM prato_bloqueado WHERE aluno_id = $1 ORDER BY nome`, [alunoId]
    );
    return rows.map(r => r.nome);
  }

  async function getUltimoPedido(c, alunoId) {
    const { rows } = await c.query(
      `SELECT dia_pedido, motivo FROM pedido
        WHERE aluno_id = $1 AND motivo NOT ILIKE '%anteriormente%' AND motivo NOT LIKE '%Final%'
        ORDER BY dia_pedido DESC, id DESC LIMIT 1`, [alunoId]
    );
    return rows[0] || null;
  }

  async function getUltimosPedidos(c, alunoId) {
    const { rows } = await c.query(
      `SELECT dia_pedido, motivo FROM pedido
        WHERE aluno_id = $1 AND dia_pedido >= (CURRENT_DATE - INTERVAL '7 days')
          AND motivo NOT ILIKE '%anteriormente%' AND motivo NOT LIKE '%Final%'
        ORDER BY dia_pedido DESC, id DESC`, [alunoId]
    );
    return rows;
  }

  // === NOVA FUNÇÃO: PEGAR PRATO ATUAL (Do Banco) ===
  async function getPratoAtual(c) {
    // Pega o registro mais recente que foi atualizado no banco
    // A tabela é 'proximo_prato' (dia_referente, prato_nome, updated_at)
    const { rows } = await c.query(
      `SELECT dia_referente, prato_nome FROM proximo_prato ORDER BY updated_at DESC LIMIT 1`
    );
    return rows[0] || null;
  }

  function helpText(aluno, ultimoPedido, pratoAtual) {
    return (
      header(aluno, ultimoPedido, pratoAtual) +
      "Menu principal\n\n" +
      "• *Cancelar* → mandar e-mail de cancelamento de almoço para a CAE\n" +
      "• *Preferência* → escolher dias em que você costuma almoçar no câmpus\n" +
      "• *Bloquear* → informar pratos que você não come / quer evitar\n" +
      "• *Ativar* / *Desativar* → ligar ou pausar seu cadastro\n" +
      "• *Status* → ver seus dados, dias cadastrados e pratos bloqueados\n" +
      "• *Histórico* → ver pedidos dos últimos dias e o motivo de cada um\n\n" +
      "Pra ver esse menu de novo, envie: *Ajuda*."
    );
  }

  const ONBOARDING =
    "IFSP Pirituba | Assistente de Almoço\n--------------------------------\n" +
    "Eu ajudo a registrar cancelamento de almoço (via e-mail para a CAE)\n" +
    "e preferências (dias e pratos) no sistema de pedidos de almoço do câmpus Pirituba.\n\n" +
    "Pra começar o cadastro, envie: *CONTINUAR*.\n" +
    "Se não quiser agora, pode voltar a qualquer momento enviando *Ajuda*.";

  // --------- handler principal ----------
  async function handleText(jid, textRaw) {
    const text = strip(textRaw);
    if (!text) return null;

    const userKey = jidToPhone(jid);
    const u = getUser(userKey);
    const phone = userKey;

    const { aluno, ultimoPedido, pratoAtual } = await withConn(async c => {
        const a = await findAlunoByTelefone(c, phone);
        const up = a ? await getUltimoPedido(c, a.id) : null;
        const pa = await getPratoAtual(c);
        return { aluno: a, ultimoPedido: up, pratoAtual: pa };
    });

    if (aluno && !u.aluno_id) {
      setUser(userKey, { aluno_id: aluno.id, step: "MAIN", temp: {} });
    }

    const n = norm(text);

    // atalhos globais
    if (["ajuda", "menu", "help", "comandos"].includes(n)) {
      setUser(userKey, { step: "MAIN", temp: {} });
      return helpText(aluno || null, ultimoPedido, pratoAtual);
    }

    if (n === "status" || n === "meu status" || n === "cadastro") {
      if (!aluno) return header(null, null, pratoAtual) + "Seu número ainda *não está vinculado*. Envie: *CONTINUAR*.";

      const info = await withConn(async c => {
        const dias = await getPreferenciasDias(c, aluno.id);
        const bloqueios = await getBloqueiosAluno(c, aluno.id);
        return { dias, bloqueios };
      });

      const diasTxt = info.dias.length ? diasHumanos(info.dias) : "nenhum";
      const bloqueiosTxt = info.bloqueios.length ? info.bloqueios.join(", ") : "nenhum";

      return (
        header(aluno, ultimoPedido, pratoAtual) +
        "*Status do seu cadastro*\n\n" +
        `• Nome: *${aluno.nome || "não informado"}*\n` +
        `• Prontuário: *${aluno.prontuario || "não informado"}*\n` +
        `• Cadastro ativo: *${aluno.ativo ? "Sim" : "Não"}*\n` +
        `• Dias cadastrados: *${diasTxt}*\n` +
        `• Pratos bloqueados: *${bloqueiosTxt}*\n\n` +
        "Envie *Ajuda* para ver o menu de comandos."
      );
    }

    if (n.includes("historico")) {
      if (!aluno) return header(null, null, pratoAtual) + "Cadastro não encontrado. Envie *CONTINUAR*.";

      const pedidos = await withConn(c => getUltimosPedidos(c, aluno.id));
      if (!pedidos.length) {
        return header(aluno, ultimoPedido, pratoAtual) + "Histórico de pedidos\n\nNão encontrei registros recentes.";
      }

      const linhas = pedidos.map(p => {
        const data = formatDiaBR(p.dia_pedido);
        const { tipo, detalhe, bruto } = classificaMotivo(p.motivo);
        let desc = bruto;
        if (tipo === "PEDIU_OK") desc = "✅ Pedido com sucesso.";
        else if (tipo === "NAO_PEDIU") desc = "⚠️ Bloqueado/Pulo.";
        else if (tipo === "ERRO_PEDIDO") desc = "❌ Erro no site.";
        
        if(detalhe) desc += ` (${detalhe})`;
        return `• ${data} → ${desc}`;
      });

      return (
        header(aluno, ultimoPedido, pratoAtual) +
        "Histórico de pedidos (7 dias)\n\n" +
        linhas.join("\n")
      );
    }

    // ================= cadastro =================
    if (!aluno) {
      if (u.step === "ASK_PRONT") {
          let pront = strip(text).replace(/\s+/g, "").toUpperCase().replace(/^PT/, "").replace(/\D/g, "");
          if (!/^\d{5,12}$/.test(pront)) {
            return header(null, null, pratoAtual) + "*Formato inválido.* Envie algo como *3029791*.";
          }
          setUser(userKey, { step: "ASK_DIAS_REG", temp: { prontuario: pront } });
          return header(null, null, pratoAtual) + "*Prontuário recebido!*\nAgora envie os dias (ex: *seg, ter*).";
      }
  
      if (n.includes("continuar") || n.includes("sim") || n.includes("bora") || n.includes("quero")) {
             setUser(userKey, { step: "ASK_PRONT", temp: {} });
             return header(null, null, pratoAtual) + "*Cadastro Piloto*\nEnvie seu prontuário IFSP (apenas números).";
      }

      if (u.step === "ASK_CONSENT") {
             return header(null, null, pratoAtual) + "Tranquilo. Quando quiser, envie *CONTINUAR*.";
      }

      if (u.step === "NEW") {
         setUser(userKey, { step: "ASK_CONSENT", temp: {} });
         return ONBOARDING;
      }

      if (u.step === "ASK_DIAS_REG") {
        const dias = parseDiasLista(text);
        if (!dias.length) return header(null, null, pratoAtual) + "Não entendi. Envie ex: *seg, qua*.";

        const pront = u.temp?.prontuario;
        if (!pront) {
          setUser(userKey, { step: "NEW", temp: {} });
          return ONBOARDING;
        }

        const res = await withConn(async c => {
          const vinculo = await ensureAlunoContato(c, { prontuario: pront, telefone: phone });
          if (!vinculo.ok) return vinculo;
          await setPreferenciasDias(c, vinculo.alunoId, dias);
          await setAtivo(c, vinculo.alunoId, true);
          return vinculo;
        });

        if (!res.ok) {
          if (res.reason === "NAO_TURMA") return header(null, null, pratoAtual) + "*Prontuário não encontrado na turma.*";
          if (res.reason === "JA_VINCULADO") return header(null, null, pratoAtual) + "*Prontuário já vinculado a outro número.*";
          return header(null, null, pratoAtual) + "Erro no sistema.";
        }

        const alunoBanco = { nome: res.aluno?.nome, prontuario: res.aluno?.prontuario, ativo: true };
        setUser(userKey, { step: "MAIN", temp: {}, aluno_id: res.alunoId });
        return header(alunoBanco, null, pratoAtual) + "*Cadastro concluído!* Envie *Ajuda* para ver opções.";
      }
      return ONBOARDING;
    }

    // ================= aluno logado =================
    const alunoAtual = aluno;

    if (u.step === "SET_DIAS") {
      const dias = parseDiasLista(text);
      if (!dias.length) return header(alunoAtual, ultimoPedido, pratoAtual) + "Não entendi. Envie ex: *seg, ter*.";
      await withConn(c => setPreferenciasDias(c, alunoAtual.id, dias));
      setUser(userKey, { step: "MAIN", temp: {} });
      return header(alunoAtual, ultimoPedido, pratoAtual) + `*Dias atualizados:* ${diasHumanos(dias)}.`;
    }

    if (u.step === "SET_BLOQ") {
      const itens = text.split(/[,;\n]+/).map(strip).filter(Boolean);
      if (!itens.length) return header(alunoAtual, ultimoPedido, pratoAtual) + "Envie os pratos para bloquear (ex: peixe).";
      await withConn(c => addBloqueios(c, alunoAtual.id, itens));
      setUser(userKey, { step: "MAIN", temp: {} });
      return header(alunoAtual, ultimoPedido, pratoAtual) + `*Bloqueios salvos:* ${itens.join(", ")}.`;
    }

    if (u.step === "CONFIRM_CANCEL") {
      const d = new Date(u.temp?.cancelDate || new Date());
      const alvo = `${DIA_LONGO[d.getDay()]} ${ddmm(d)}`;
      const alvoIso = isoDateUTC(d);

      if (["sim", "s", "ok", "yes", "confirmar"].includes(n)) {
        if (u.lastCancelDate === alvoIso) {
          return header(alunoAtual, ultimoPedido, pratoAtual) + "*Já existe pedido de cancelamento para este dia.*";
        }
        const resEmail = await sendCancelEmail({ aluno: alunoAtual, alvoDate: d, phone });
        if (!resEmail.ok) return header(alunoAtual, ultimoPedido, pratoAtual) + "Erro ao enviar e-mail.";
        
        setUser(userKey, { step: "MAIN", temp: {}, lastCancelDate: alvoIso });
        return header(alunoAtual, ultimoPedido, pratoAtual) + `*Cancelamento enviado para ${alvo}.*`;
      }
      if (["nao", "não", "n", "cancelar"].includes(n)) {
        setUser(userKey, { step: "MAIN", temp: {} });
        return header(alunoAtual, ultimoPedido, pratoAtual) + "Cancelamento abortado.";
      }
      return header(alunoAtual, ultimoPedido, pratoAtual) + `Confirma cancelar almoço de *${alvo}*? (Sim/Não)`;
    }

    if (n.startsWith("cancelar") || n.includes("nao vou")) {
      const alvoDate = diaCancelamentoAlvo(new Date());
      const alvo = `${DIA_LONGO[alvoDate.getDay()]} ${ddmm(alvoDate)}`;
      const alvoIso = isoDateUTC(alvoDate);

      if (u.lastCancelDate === alvoIso) return header(alunoAtual, ultimoPedido, pratoAtual) + "*Já existe cancelamento para este dia.*";
      
      setUser(userKey, { step: "CONFIRM_CANCEL", temp: { cancelDate: alvoDate } });
      return header(alunoAtual, ultimoPedido, pratoAtual) + `Deseja cancelar o almoço de *${alvo}*? Responda *Sim*.`;
    }

    if (n.startsWith("preferencia") || n === "dias") {
      setUser(userKey, { step: "SET_DIAS", temp: {} });
      return header(alunoAtual, ultimoPedido, pratoAtual) + "Envie os dias que almoça (ex: seg, qua).";
    }

    if (n.startsWith("bloquear") || n.includes("nao como")) {
      setUser(userKey, { step: "SET_BLOQ", temp: {} });
      return header(alunoAtual, ultimoPedido, pratoAtual) + "Envie pratos para bloquear (separados por vírgula).";
    }

    if (n === "ativar") {
      await withConn(c => setAtivo(c, alunoAtual.id, true));
      return header({ ...alunoAtual, ativo: true }, ultimoPedido, pratoAtual) + "Cadastro *ativado*.";
    }

    if (n === "desativar" || n === "pausar") {
      await withConn(c => setAtivo(c, alunoAtual.id, false));
      return header({ ...alunoAtual, ativo: false }, ultimoPedido, pratoAtual) + "Cadastro *pausado*.";
    }

    return header(alunoAtual, ultimoPedido, pratoAtual) + "Não entendi. Envie *Ajuda*.";
  }

  async function close() {
    try { await pool.end(); } catch { }
  }

  return { handleText, close };
}
