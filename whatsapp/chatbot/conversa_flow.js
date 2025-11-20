// whatsapp/chatbot/conversa_flow.js
import fs from "fs";
import path from "path";
import { Pool } from "pg";
import nodemailer from "nodemailer";

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

function isoDateUTC(d) {
  // YYYY-MM-DD, usado só para comparar "mesmo dia alvo" no state
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
  // <= 13:15 → hoje; > 13:15 → amanhã
  return (now <= cutoff1315(now)) ? now : addDays(now, 1);
}

// ---- helpers de data / motivo para pedidos ----
function formatDiaBR(dateLike) {
  if (!dateLike) return "?";
  const s = String(dateLike);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    return `${m[3]}/${m[2]}`;
  }
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return s;
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}`;
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

function resumoUltimoPedidoLinha(ultimo) {
  if (!ultimo) {
    return "Último registro de pedido: ainda não há nenhum registro recente.\n";
  }
  const data = formatDiaBR(ultimo.dia_pedido);
  const { tipo, detalhe, bruto } = classificaMotivo(ultimo.motivo);

  let txt;
  if (tipo === "NAO_PEDIU") {
    txt = "não foi feito pedido automático (provavelmente por bloqueio de prato).";
  } else if (tipo === "PEDIU_OK") {
    txt = "pedido feito normalmente pelo sistema automático.";
  } else if (tipo === "ERRO_PEDIDO") {
    txt = "houve erro ao tentar pedir no site.";
  } else {
    txt = bruto || "motivo não registrado.";
  }
  return `Último registro de pedido: ${data} – ${txt}\n`;
}

// ---- header / identidade visual ----
function header(aluno, ultimoPedido) {
  const titulo = "IFSP Pirituba | Assistente de Almoço\n";
  if (!aluno) {
    let base =
      titulo +
      "Você está falando com o robô que ajuda no sistema de pedidos de almoço do câmpus.\n" +
      resumoUltimoPedidoLinha(null) +
      "--------------------------------\n";
    return base;
  }
  const pront = aluno.prontuario || "não informado";
  const nome = aluno.nome || "Aluno";
  let txt =
    titulo +
    `Aluno: ${nome}\n` +
    `Prontuário: ${pront}\n` +
    resumoUltimoPedidoLinha(ultimoPedido) +
    "--------------------------------\n";
  return txt;
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

  function getUser(jid) {
    return state[jid] || (state[jid] = { step: "NEW", temp: {} });
  }

  function setUser(jid, patch) {
    state[jid] = { ...(state[jid] || { step: "NEW", temp: {} }), ...patch };
    saveState();
  }

// --- helper para envio de e-mail de cancelamento ---
  async function sendCancelEmail({ aluno, alvoDate, phone }) {
    if (!mailTransporter || !CAE_EMAIL) {
      logger.error("E-mail de cancelamento não configurado (GMAIL_USER / GMAIL_APP_PASSWORD / CAE_EMAIL).");
      return { ok: false, reason: "NO_TRANSPORT" };
    }

    const dataStr = ddmm(alvoDate);
    const diaSemana = DIA_LONGO[alvoDate.getDay()];
    const nome = aluno.nome || "Aluno";
    const prontBase = String(aluno.prontuario || "").toUpperCase();
    const prontCompleto = prontBase.startsWith("PT") ? prontBase : `PT${prontBase}`;
    const prontNumerico = onlyDigits(prontBase); // Apenas números para cópia fácil
    const tel = phone || "";

    const subject = `Cancelamento de almoço - ${prontCompleto} - ${dataStr}`;
    
    // Corpo em HTML para melhor visualização e facilidade
    const html = `
      <div style="font-family: Arial, sans-serif; color: #333;">
        <h2 style="color: #d9534f;">Solicitação de Cancelamento de Almoço</h2>
        <p><strong>Aluno:</strong> ${nome}</p>
        <p><strong>Prontuário:</strong> ${prontCompleto}</p>
        
        <div style="background-color: #f8f9fa; border: 1px solid #ddd; padding: 15px; margin: 20px 0; border-radius: 5px;">
          <p style="margin: 0 0 10px;">Para copiar o prontuário (apenas números):</p>
          <span style="font-size: 24px; font-weight: bold; letter-spacing: 2px; background: #fff; padding: 5px 10px; border: 1px dashed #999;">
            ${prontNumerico}
          </span>
        </div>

        <p><strong>Data a cancelar:</strong> ${diaSemana}, ${dataStr}</p>
        <p><strong>Telefone (WhatsApp):</strong> <a href="https://wa.me/${tel}">${tel}</a></p>
        
        <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
        <p style="font-size: 12px; color: #777;">
          Mensagem gerada automaticamente pelo Assistente de Almoço (piloto 2º ano Redes).
        </p>
      </div>
    `;

    // Mantemos o texto puro como fallback
    const text = `Solicitação de cancelamento:\nAluno: ${nome}\nProntuário: ${prontNumerico}\nData: ${dataStr}`;

    try {
      await mailTransporter.sendMail({
        from: `"Assistente de Almoço IFSP Pirituba" <${GMAIL_USER}>`,
        to: CAE_EMAIL,
        subject,
        text, // Fallback texto puro
        html, // Versão HTML rica
      });
      logger.info?.("E-mail de cancelamento enviado com sucesso para", CAE_EMAIL);
      return { ok: true };
    } catch (err) {
      logger.error("Erro ao enviar e-mail de cancelamento:", err);
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
    if (!aluno) {
      return { ok: false, reason: "NAO_TURMA" };
    }

    const { rows } = await c.query(
      `SELECT telefone FROM contato WHERE aluno_id = $1 LIMIT 1`,
      [aluno.id]
    );

    if (rows.length) {
      const telExistente = onlyDigits(rows[0].telefone || "");
      const telNovo = onlyDigits(telefone || "");
      if (telExistente !== telNovo) {
        return {
          ok: false,
          reason: "JA_VINCULADO",
          telefone: telExistente,
          aluno
        };
      }
      return { ok: true, alunoId: aluno.id, aluno };
    }

    await c.query(
      `INSERT INTO contato (aluno_id, telefone) VALUES ($1,$2)`,
      [aluno.id, telefone]
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
         )`,
        [alunoId, nome]
      );
    }
  }

  async function setAtivo(c, alunoId, ativo) {
    await c.query(`UPDATE aluno SET ativo=$2 WHERE id=$1`, [alunoId, !!ativo]);
  }

  async function getPreferenciasDias(c, alunoId) {
    const { rows } = await c.query(
      `SELECT dia_semana
         FROM preferencia_dia
        WHERE aluno_id = $1
        ORDER BY dia_semana`,
      [alunoId]
    );
    return rows.map(r => r.dia_semana);
  }

  async function getBloqueiosAluno(c, alunoId) {
    const { rows } = await c.query(
      `SELECT nome
         FROM prato_bloqueado
        WHERE aluno_id = $1
        ORDER BY nome`,
      [alunoId]
    );
    return rows.map(r => r.nome);
  }

  async function getUltimoPedido(c, alunoId) {
    const { rows } = await c.query(
      `SELECT dia_pedido, motivo
         FROM pedido
        WHERE aluno_id = $1
        ORDER BY dia_pedido DESC, id DESC
        LIMIT 1`,
      [alunoId]
    );
    return rows[0] || null;
  }

  async function getUltimosPedidos(c, alunoId) {
    const { rows } = await c.query(
      `SELECT dia_pedido, motivo
         FROM pedido
        WHERE aluno_id = $1
          AND dia_pedido >= (CURRENT_DATE - INTERVAL '7 days')
        ORDER BY dia_pedido DESC, id DESC`,
      [alunoId]
    );
    return rows;
  }

  // --------- textos de apoio ----------
  function helpText(aluno, ultimoPedido) {
    return (
      header(aluno, ultimoPedido) +
      "Menu principal\n\n" +
      "• *Cancelar*  → mandar e-mail de cancelamento de almoço para a CAE\n" +
      "• *Preferência*  → escolher dias em que você costuma almoçar no câmpus\n" +
      "• *Bloquear*  → informar pratos que você não come / quer evitar\n" +
      "• *Ativar* / *Desativar*  → ligar ou pausar seu cadastro\n" +
      "• *Status*  → ver seus dados, dias cadastrados e pratos bloqueados\n" +
      "• *Histórico*  → ver pedidos dos últimos dias e o motivo de cada um\n\n" +
      "Pra ver esse menu de novo, envie: *Ajuda*."
    );
  }

  const ONBOARDING =
    header(null, null) +
    "Eu ajudo a registrar cancelamento de almoço (via e-mail para a CAE)\n" +
    "e preferências (dias e pratos) no sistema de pedidos de almoço do câmpus Pirituba.\n\n" +
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

    const ultimoPedido = aluno
      ? await withConn(c => getUltimoPedido(c, aluno.id))
      : null;

    const n = norm(text);

    // atalhos globais
    if (["ajuda", "menu", "help", "comandos"].includes(n)) {
      setUser(jid, { step: "MAIN", temp: {} });
      return helpText(aluno || null, ultimoPedido);
    }

    if (n === "status" || n === "meu status" || n === "cadastro") {
      if (!aluno) {
        return (
          header(null, null) +
          "Seu número ainda *não está vinculado* a nenhum cadastro de aluno no sistema de almoço do IFSP Pirituba.\n\n" +
          "Pra começar o cadastro, envie: *CONTINUAR*."
        );
      }

      const info = await withConn(async c => {
        const dias = await getPreferenciasDias(c, aluno.id);
        const bloqueios = await getBloqueiosAluno(c, aluno.id);
        return { dias, bloqueios };
      });

      const diasTxt = info.dias.length
        ? diasHumanos(info.dias)
        : "nenhum dia cadastrado";
      const bloqueiosTxt = info.bloqueios.length
        ? info.bloqueios.join(", ")
        : "nenhum prato bloqueado";

      return (
        header(aluno, ultimoPedido) +
        "*Status do seu cadastro*\n\n" +
        `• Nome: *${aluno.nome || "não informado"}*\n` +
        `• Prontuário: *${aluno.prontuario || "não informado"}*\n` +
        `• Cadastro ativo: *${aluno.ativo ? "Sim" : "Não"}*\n` +
        `• Dias cadastrados: *${diasTxt}*\n` +
        `• Pratos bloqueados: *${bloqueiosTxt}*\n\n` +
        "Envie *Ajuda* para ver o menu de comandos."
      );
    }

    if (
      n === "historico" ||
      n === "historico pedidos" ||
      n === "meus pedidos" ||
      n === "ultimos pedidos" ||
      n === "últimos pedidos"
    ) {
      if (!aluno) {
        return (
          header(null, null) +
          "Ainda não encontrei seu cadastro de aluno.\n\n" +
          "Pra começar o cadastro e ter histórico de pedidos, envie *CONTINUAR*."
        );
      }

      const pedidos = await withConn(c => getUltimosPedidos(c, aluno.id));

      if (!pedidos.length) {
        return (
          header(aluno, ultimoPedido) +
          "Histórico de pedidos (últimos 7 dias)\n\n" +
          "Não encontrei nenhum registro de pedido recente pra este prontuário."
        );
      }

      const linhas = pedidos.map(p => {
        const data = formatDiaBR(p.dia_pedido);
        const { tipo, detalhe, bruto } = classificaMotivo(p.motivo);
        let desc;
        if (tipo === "PEDIU_OK") {
          desc = "Foi feito pedido automático com sucesso no site do SICA.";
          if (detalhe) desc += ` Detalhe: ${detalhe}`;
        } else if (tipo === "NAO_PEDIU") {
          desc = "Não foi feito pedido automático, pois o prato tinha algum item bloqueado nas suas preferências.";
          if (detalhe) desc += ` Detalhe: ${detalhe}`;
        } else if (tipo === "ERRO_PEDIDO") {
          desc = "Tentamos fazer o pedido automático, mas o site respondeu com erro.";
          if (detalhe) desc += ` Detalhe: ${detalhe}`;
        } else {
          desc = bruto || "Motivo não informado.";
        }
        return `• ${data} → ${desc}`;
      });

      return (
        header(aluno, ultimoPedido) +
        "Histórico de pedidos (últimos 7 dias)\n\n" +
        linhas.join("\n") +
        "\n\nSe quiser revisar suas preferências, envie *Preferência* ou *Bloquear*."
      );
    }

    // ================= cadastro (ainda não existe no banco) =================
    if (!aluno) {
      // fast-forward do consentimento: agora só pedimos PT (sem PT no BD)
      if (["sim", "s", "ok", "yes", "continuar"].includes(n)) {
        setUser(jid, { step: "ASK_PRONT", temp: {} });
        return (
          header(null, null) +
          "*Cadastro de aluno – Piloto 2º ano Redes*\n\n" +
          "Agora envie seu prontuário IFSP (ex.: 3029701). Não precisa colocar PT na frente."
        );
      }

      if (u.step === "NEW") {
        setUser(jid, { step: "ASK_CONSENT", temp: {} });
        return ONBOARDING;
      }

      if (u.step === "ASK_CONSENT") {
        return (
          header(null, null) +
          "Tranquilo, sem problemas.\n\n" +
          "Quando você quiser usar o sistema automático de pedidos de almoço do IFSP Pirituba,\n" +
          "basta responder *CONTINUAR*."
        );
      }

      if (u.step === "ASK_PRONT") {
        // remove espaços, PT no começo e tudo que não for dígito
        let pront = strip(text)
          .replace(/\s+/g, "")
          .toUpperCase()
          .replace(/^PT/, "");
        pront = pront.replace(/\D/g, "");

        if (!/^\d{5,12}$/.test(pront)) {
          return (
            header(null, null) +
            "*Formato de prontuário inválido.*\n\n" +
            "Envie algo como *3029791*.\n" +
            "Use o mesmo código numérico que aparece no SUAP (sem PT)."
          );
        }

        setUser(jid, { step: "ASK_DIAS_REG", temp: { prontuario: pront } });

        return (
          header(null, null) +
          "*Prontuário recebido!*\n\n" +
          "Agora me diga em quais dias você *costuma almoçar* no câmpus.\n" +
          "Exemplo: *seg, ter, qua, qui, sex*."
        );
      }

      if (u.step === "ASK_DIAS_REG") {
        const dias = parseDiasLista(text);
        if (!dias.length) {
          return (
            header(null, null) +
            "Não entendi os dias.\n\n" +
            "Exemplos válidos: *seg, qua, sex* ou *segunda, terça, quinta*."
          );
        }

        const pront = u.temp?.prontuario;
        if (!pront) {
          setUser(jid, { step: "NEW", temp: {} });
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
          if (res.reason === "NAO_TURMA") {
            return (
              header(null, null) +
              "*Prontuário não encontrado na turma do piloto.*\n\n" +
              "Este teste está habilitado só para o *2º ano de Redes*.\n" +
              "Confere se você digitou o código igual ao do SUAP."
            );
          }
          if (res.reason === "JA_VINCULADO") {
            return (
              header(null, null) +
              "*Esse prontuário já foi cadastrado antes.*\n\n" +
              "Ele já está vinculado a outro número de WhatsApp.\n" +
              "Se isso estiver errado, procure a CAE ou o responsável pelo projeto."
            );
          }

          return (
            header(null, null) +
            "Tive um problema ao salvar seu cadastro.\n" +
            "Tenta novamente mais tarde ou fala com o responsável pelo projeto."
          );
        }

        const alunoBanco = {
          nome: res.aluno?.nome,
          prontuario: res.aluno?.prontuario,
          ativo: true
        };

        setUser(jid, { step: "MAIN", temp: {}, aluno_id: res.alunoId });

        return (
          header(alunoBanco, null) +
          "*Cadastro concluído no sistema automático de pedidos (piloto 2º ano Redes).* \n\n" +
          `Dias preferidos registrados: *${diasHumanos(dias)}*.\n\n` +
          "A partir de agora, você pode:\n" +
          "• Enviar *Cancelar* para mandar um e-mail de cancelamento de almoço.\n" +
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
          header(alunoAtual, ultimoPedido) +
          "Não entendi os dias.\n\n" +
          "Envie algo como: *seg, qua, sex* ou *segunda, terça, quinta*."
        );
      }
      await withConn(c => setPreferenciasDias(c, alunoAtual.id, dias));
      setUser(jid, { step: "MAIN", temp: {} });
      return (
        header(alunoAtual, ultimoPedido) +
        "*Preferências de dias atualizadas!*\n\n" +
        `Dias cadastrados para o refeitório do câmpus Pirituba: *${diasHumanos(dias)}*.\n\n` +
        "Envie *Ajuda* para voltar ao menu."
      );
    }

    if (u.step === "SET_BLOQ") {
      const itens = text.split(/[,;\n]+/).map(strip).filter(Boolean);
      if (!itens.length) {
        return (
          header(alunoAtual, ultimoPedido) +
          "Não encontrei nenhum prato na sua mensagem.\n\n" +
          "Envie os *pratos* que deseja bloquear, separados por vírgula.\n" +
          "Ex.: *carne moída, estrogonofe*."
        );
      }
      await withConn(c => addBloqueios(c, alunoAtual.id, itens));
      setUser(jid, { step: "MAIN", temp: {} });
      return (
        header(alunoAtual, ultimoPedido) +
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
      const alvoIso = isoDateUTC(d);

      // se já cancelou esse dia antes, não manda outro e-mail
      if (["sim", "s", "ok", "yes", "confirmar", "confirmo"].includes(n)) {
        if (u.lastCancelDate === alvoIso) {
          return (
            header(alunoAtual, ultimoPedido) +
            "*Esse almoço já teve um pedido de cancelamento registrado para esse número.*\n\n" +
            `Alvo: *${alvo}*.\n` +
            "Não vou enviar outro e-mail para evitar duplicidade.\n\n" +
            "Se achar que houve erro, procure a CAE."
          );
        }

        const resEmail = await sendCancelEmail({ aluno: alunoAtual, alvoDate: d, phone });

        if (!resEmail.ok) {
          return (
            header(alunoAtual, ultimoPedido) +
            "Tentei mandar o e-mail de cancelamento, mas aconteceu um erro técnico.\n\n" +
            "Recomendo cancelar manualmente pelo site ou diretamente com a CAE.\n\n" +
            "Detalhe técnico (para o responsável pelo sistema): " +
            (resEmail.reason || "erro ao enviar e-mail") +
            "."
          );
        }

        setUser(jid, { step: "MAIN", temp: {}, lastCancelDate: alvoIso });

        return (
          header(alunoAtual, ultimoPedido) +
          "*Pedido de cancelamento registrado.*\n\n" +
          `Enviei um e-mail para a CAE pedindo o cancelamento do almoço de *${alvo}*,\n` +
          `usando o seu prontuário *${alunoAtual.prontuario}*.\n\n` +
          "Guarde esta mensagem como comprovante.\n" +
          "Envie *Status* para ver seus dados ou *Ajuda* para o menu."
        );
      }

      if (["nao", "não", "n", "cancelar", "voltar", "parar"].includes(n)) {
        setUser(jid, { step: "MAIN", temp: {} });
        return (
          header(alunoAtual, ultimoPedido) +
          "Beleza, não vou registrar nenhum cancelamento agora.\n\n" +
          "Se quiser cancelar depois, envie *Cancelar*.\n" +
          "Envie *Ajuda* para ver as opções."
        );
      }

      // se mandou algo aleatório, repete a confirmação
      return (
        header(alunoAtual, ultimoPedido) +
        "Só pra confirmar:\n\n" +
        `Você deseja que eu mande um *e-mail de cancelamento do almoço de ${alvo}* ` +
        `para a CAE do IFSP Pirituba usando o seu prontuário *${alunoAtual.prontuario}*?\n\n` +
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
      const alvoIso = isoDateUTC(alvoDate);

      // se já cancelou esse alvo, nem entra em confirmação
      if (u.lastCancelDate === alvoIso) {
        return (
          header(alunoAtual, ultimoPedido) +
          "*Já existe um pedido de cancelamento registrado para esse dia usando este número.*\n\n" +
          `Alvo atual pelas regras de horário: *${alvo}*.\n` +
          "Não vou abrir outro pedido para evitar duplicidade.\n\n" +
          "Se achar que houve algum erro, procure a CAE."
        );
      }

      setUser(jid, { step: "CONFIRM_CANCEL", temp: { cancelDate: alvoDate } });

      return (
        header(alunoAtual, ultimoPedido) +
        "Cancelamento de almoço\n\n" +
        "Regras da CAE (almoço):\n" +
        "• Até *13:15*: cancela o almoço de *hoje*.\n" +
        "• Depois de *13:15*: cancela o almoço de *amanhã*.\n\n" +
        `Pela hora atual, o alvo é: *${alvo}*.\n\n` +
        `Confirmar que eu mande um e-mail para cancelar esse almoço usando seu prontuário *${alunoAtual.prontuario}*?\n\n` +
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
        header(alunoAtual, ultimoPedido) +
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
        header(alunoAtual, ultimoPedido) +
        "Bloquear pratos no sistema\n\n" +
        "Envie os *pratos* que você não come / tem alergia / prefere evitar,\n" +
        "separados por vírgula. Ex.: *frango xadrez, feijoada*."
      );
    }

    if (n === "ativar") {
      await withConn(c => setAtivo(c, alunoAtual.id, true));
      return (
        header({ ...alunoAtual, ativo: true }, ultimoPedido) +
        "Seu cadastro no sistema automático de almoço do IFSP Pirituba foi *ativado*.\n\n" +
        "Você continuará recebendo as ações com base nas suas preferências.\n" +
        "Envie *Ajuda* para ver o menu."
      );
    }

    if (n === "desativar" || n === "pausar") {
      await withConn(c => setAtivo(c, alunoAtual.id, false));
      return (
        header({ ...alunoAtual, ativo: false }, ultimoPedido) +
        "Seu cadastro no sistema automático de almoço do IFSP Pirituba foi *desativado*.\n\n" +
        "Você pode enviar *Ativar* quando quiser voltar.\n" +
        "Envie *Ajuda* para ver o menu."
      );
    }

    if (n === "cadastrar") {
      return (
        header(alunoAtual, ultimoPedido) +
        "Seu número já está *cadastrado* no sistema de almoço do IFSP Pirituba.\n\n" +
        "Envie *Ajuda* para ver o menu de comandos."
      );
    }

    // fallback padrão
    return (
      header(alunoAtual, ultimoPedido) +
      "Não entendi sua mensagem.\n\n" +
      "Envie *Ajuda* pra ver o menu de opções do assistente de almoço do IFSP Pirituba."
    );
  }

  async function close() {
    try { await pool.end(); } catch { }
  }

  return { handleText, close };
}
