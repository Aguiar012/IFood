import fs from "fs";
import path from "path";
import pkg from "pg";
const { Pool } = pkg;
import nodemailer from "nodemailer";
import { criarAssistenteIA } from "./inteligencia_artificial.js";
import { gerarImagemEmailCancelamento } from "./renderizar_email.js";

function apenasDigitos(s = "") { return (s || "").replace(/\D/g, ""); }

// Verifica se um numero parece ser telefone real (BR: 12-13 digitos) e nao LID
// Verifica se um numero parece ser telefone real (BR: 12-13 digitos) e nao LID (agora aceitamos LIDs tambem)
function eTelefoneValido(tel = "") {
    // Aceitamos qualquer ID com pelo menos 10 digitos (numeros ou LIDs)
    return apenasDigitos(tel).length >= 10;
}

// Extrai apenas os números para usar como chave (ignora @s.whatsapp.net e :device_id)
function jidParaTelefone(jid = "") {
    const idSemSufixo = String(jid).split("@")[0].split(":")[0];
    return apenasDigitos(idSemSufixo);
}

function limparTexto(s = "") { return String(s || "").trim(); }

function normalizar(s = "") {
    return limparTexto(s)
        .toLowerCase()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
}

// Formatar texto como Título (ex: "FILÉ DE FRANGO" -> "Filé De Frango")
function formatarTitulo(str) {
    if (!str) return "";
    return str.toLowerCase().replace(/(?:^|\s|["'([{])+\S/g, match => match.toUpperCase());
}

// ---- dias da semana ----
const NOMES_DIAS_SEMANA = ["Domingo", "Segunda-Feira", "Terça-Feira", "Quarta-Feira", "Quinta-Feira", "Sexta-Feira", "Sábado"];
const NOMES_DIAS_CURTO = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

function interpretarListaDias(txt = "") {
    const mapa = {
        "seg": 1, "segunda": 1, "segunda-feira": 1,
        "ter": 2, "terca": 2, "terça": 2, "terça-feira": 2,
        "qua": 3, "quarta": 3, "quarta-feira": 3,
        "qui": 4, "quinta": 4, "quinta-feira": 4,
        "sex": 5, "sexta": 5, "sexta-feira": 5,
    };
    const itens = normalizar(txt).split(/[,\s;/]+/).filter(Boolean);
    const dias = new Set();
    for (const item of itens) if (mapa[item] != null) dias.add(mapa[item]);
    return [...dias].sort((a, b) => a - b);
}

function formatarDiasHumanos(dias = []) {
    const mapaInverso = { 1: "Seg", 2: "Ter", 3: "Qua", 4: "Qui", 5: "Sex", 6: "Sáb", 7: "Dom" };
    return (dias || []).map(d => mapaInverso[d] || d).join(", ");
}

function obterNumeroDia(texto) {
    const n = normalizar(texto);
    const mapa = {
        "seg": 1, "segunda": 1, "segunda-feira": 1,
        "ter": 2, "terca": 2, "terça": 2, "terça-feira": 2,
        "qua": 3, "quarta": 3, "quarta-feira": 3,
        "qui": 4, "quinta": 4, "quinta-feira": 4,
        "sex": 5, "sexta": 5, "sexta-feira": 5,
    };
    return mapa[n] || null;
}

// Retorna a próxima data válida para um dia da semana específico
function obterProximaDataParaDiaSemana(diaAlvoSemana) {
    const agora = new Date();
    const corte = obterHorarioCorte(agora);

    let diaAtual = agora.getDay(); // 0 (Dom) a 6 (Sáb)
    let diasParaAdicionar = (diaAlvoSemana - diaAtual + 7) % 7;

    // Se cair hoje, verifica se já passou do horário de corte
    if (diasParaAdicionar === 0) {
        if (agora.getTime() > corte.getTime()) {
            diasParaAdicionar = 7; // Próxima semana
        }
    }

    const resultado = new Date(agora);
    resultado.setDate(resultado.getDate() + diasParaAdicionar);

    return resultado;
}

// ---- datas / cutoff 13:15 ----
function formatarDDMM(d) {
    const x = new Date(d);
    const dd = String(x.getDate()).padStart(2, "0");
    const mm = String(x.getMonth() + 1).padStart(2, "0");
    return `${dd}/${mm}`;
}

function dataIsoUTC(d) {
    // YYYY-MM-DD
    // Força o horário para 12:00 (meio-dia) para evitar que fuso horário (UTC-3)
    // faça a data virar no dia seguinte ou anterior ao converter para UTC.
    const x = new Date(d);
    x.setHours(12, 0, 0, 0);
    return x.toISOString().slice(0, 10);
}

function adicionarDias(d, n) {
    const x = new Date(d);
    x.setDate(x.getDate() + n);
    return x;
}

function obterHorarioCorte(dt) {
    const x = new Date(dt);
    x.setHours(13, 15, 0, 0);
    return x;
}

// Lógica que pega o próximo dia útil a partir de hoje/amanhã
function obterProximoDiaPreferido(agora = new Date(), diasPreferidos = [], ultimaDataCanceladaIso = null) {
    const corte = obterHorarioCorte(agora);
    let alvo = (agora <= corte) ? agora : adicionarDias(agora, 1);

    let limiteDias = 7;
    while (limiteDias > 0) {
        const diaSemanaAlvo = alvo.getDay(); // 0 (Dom) a 6 (Sáb)

        // 1. Pula Fim de Semana
        if (diaSemanaAlvo === 0 || diaSemanaAlvo === 6) {
            alvo = adicionarDias(alvo, 1);
            limiteDias--;
            continue;
        }

        // 2. Pula se a data for a mesma que o último cancelamento 
        if (ultimaDataCanceladaIso && dataIsoUTC(alvo) === ultimaDataCanceladaIso) {
            alvo = adicionarDias(alvo, 1);
            limiteDias--;
            continue;
        }

        // 3. Se é dia preferido (ou lista vazia), retorna
        if (diasPreferidos.length === 0 || diasPreferidos.includes(diaSemanaAlvo)) {
            return alvo;
        }

        // 4. Se não preferido, avança
        alvo = adicionarDias(alvo, 1);
        limiteDias--;
    }

    return diaCancelamentoPadrao(agora);
}

function diaCancelamentoPadrao(agora = new Date()) {
    let alvo = (agora <= obterHorarioCorte(agora)) ? agora : adicionarDias(agora, 1);
    while (alvo.getDay() === 0 || alvo.getDay() === 6) {
        alvo = adicionarDias(alvo, 1);
    }
    return alvo;
}

// ---- formatação ----
function formatarDataBR(dataOuString) {
    if (!dataOuString) return "?";
    const s = String(dataOuString);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) {
        return `${m[3]}/${m[2]}`; // DD/MM
    }
    const d = new Date(dataOuString);
    if (Number.isNaN(d.getTime())) return s;
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    return `${dd}/${mm}`;
}

function obterNomeDiaSemana(dataOuString) {
    if (!dataOuString) return "";
    const s = String(dataOuString);
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
    let d;
    if (m) {
        d = new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
    } else {
        d = new Date(dataOuString);
    }
    if (Number.isNaN(d.getTime())) return "";
    return NOMES_DIAS_SEMANA[d.getDay()];
}

function classificarMotivo(motivoBruto = "") {
    const completo = String(motivoBruto || "");
    const idx = completo.indexOf(":");
    const tag = (idx >= 0 ? completo.slice(0, idx) : completo).trim();
    const detalhe = idx >= 0 ? completo.slice(idx + 1).trim() : "";
    const tagNorm = normalizar(tag);

    let tipo = "OUTRO";
    const motivoCompleto = normalizar(completo);
    if (tagNorm.startsWith("nao_pediu") || tagNorm.startsWith("nao pediu")) {
        tipo = "NAO_PEDIU";
    } else if (tagNorm.startsWith("pediu_ok")) {
        tipo = "PEDIU_OK";
    } else if (tagNorm.startsWith("erro_pedido")) {
        // Se o erro diz "ticket gerado" ou "gerado anteriormente", na verdade o pedido ja foi feito
        if (motivoCompleto.includes("ticket gerado") || motivoCompleto.includes("gerado anteriormente")) {
            tipo = "PEDIU_OK";
        } else {
            tipo = "ERRO_PEDIDO";
        }
    } else if (motivoCompleto.includes("ticket gerado") || motivoCompleto.includes("gerado anteriormente")) {
        tipo = "PEDIU_OK";
    }

    return { tipo, detalhe, bruto: completo };
}

// ---- MENU PRINCIPAL ----

// Calcula segunda-feira da semana atual (em horario local)
function obterSegundaDaSemana(agora = new Date()) {
    const d = new Date(agora);
    const diaSemana = d.getDay(); // 0=Dom, 1=Seg, ..., 6=Sab
    const diff = diaSemana === 0 ? -6 : 1 - diaSemana;
    d.setDate(d.getDate() + diff);
    d.setHours(0, 0, 0, 0);
    return d;
}

function gerarCabecalho(aluno, pratoAtual, dadosSemana = null) {
    if (!aluno) {
        return "*IFSP Pirituba - Almoço*\n\n";
    }

    const nome = aluno.nome?.split(" ")[0] || "Aluno";

    // Prato do proximo dia util (esconde se for "nao cadastrado")
    let linhaPrato = "";
    if (pratoAtual?.prato_nome) {
        const pratoNorm = normalizar(pratoAtual.prato_nome);
        const eValido = !pratoNorm.includes("nao identificado") && !pratoNorm.includes("erro");
        if (eValido) {
            const dataPrato = formatarDataBR(pratoAtual.dia_referente);
            const diaPrato = NOMES_DIAS_CURTO[new Date(pratoAtual.dia_referente).getDay()] || "";
            linhaPrato = `Cardápio ${diaPrato} ${dataPrato}: *${formatarTitulo(pratoAtual.prato_nome)}*`;
        }
    }

    // Tabela visual da semana

    // Tabela visual da semana (Refatorada para UX)
    let tabelaSemana = "";
    if (dadosSemana) {
        const diasSemana = [1, 2, 3, 4, 5];
        const nomeDias = ["Seg", "Ter", "Qua", "Qui", "Sex"];

        let diasVou = [];
        let diasNaoVou = [];
        let diasPediu = [];
        let diasErro = [];

        const agora = new Date();
        const hojeIso = dataIsoUTC(agora);

        // Determina a segunda-feira da semana visualizada
        // Se for Sabado ou Domingo, mostra a PROXIMA semana
        let segunda = obterSegundaDaSemana(agora);
        if (agora.getDay() === 0 || agora.getDay() === 6) {
            segunda.setDate(segunda.getDate() + 7);
        }

        for (let i = 0; i < 5; i++) {
            const diaNum = diasSemana[i];
            const dataDodia = new Date(segunda);
            dataDodia.setDate(segunda.getDate() + i);
            const diaIso = dataIsoUTC(dataDodia);
            const nomeDia = nomeDias[i];

            const pedido = dadosSemana.pedidos.find(p => dataIsoUTC(p.dia_pedido) === diaIso);
            const estaRegistrado = dadosSemana.diasPreferidos.includes(diaNum);

            if (pedido) {
                const { tipo } = classificarMotivo(pedido.motivo);
                if (tipo === "PEDIU_OK") {
                    diasPediu.push(`${nomeDia}`);
                } else if (tipo === "NAO_PEDIU" || pedido.motivo.includes("CANCELADO")) {
                    diasNaoVou.push(nomeDia);
                } else {
                    diasErro.push(`${nomeDia}`);
                }
            } else {
                if (estaRegistrado) {
                    diasVou.push(nomeDia);
                } else {
                    diasNaoVou.push(nomeDia);
                }
            }
        }

        tabelaSemana += "\n*Resumo da Semana:*\n";

        if (diasPediu.length) tabelaSemana += `✅ *Já Pedi:* ${diasPediu.join(", ")}\n`;
        if (diasVou.length) tabelaSemana += `📅 *Vai Pedir:* ${diasVou.join(", ")}\n`;
        if (diasNaoVou.length) tabelaSemana += `❌ *Não Vai:* ${diasNaoVou.join(", ")}\n`;
        if (diasErro.length) tabelaSemana += `⚠️ *Sem Dados:* ${diasErro.join(", ")}\n`;

        tabelaSemana += "\n";
    }


    return (
        `*IFSP Pirituba - Almoço*\n` +
        `Oi ${nome}!\n` +
        (linhaPrato ? `${linhaPrato}\n` : "") +
        tabelaSemana +
        `───────────────\n`
    );
}

// -----------------------------------------------------

// ---- FUNÇÕES DE MENSAGEM ----
// Nota: Botões/Listas nativos do WhatsApp NÃO funcionam em contas normais (só Business API).
// Usamos menus numerados com emojis que funcionam universalmente.

function criarTexto(texto) {
    return { text: texto };
}

function criarBotoes(texto, rodape, opcoes = []) {
    // Gera texto com opções numeradas
    // opcoes = [{ id: 'sim', texto: 'Sim' }, ...]
    let msg = texto;
    if (opcoes.length) {
        msg += "\n";
        opcoes.forEach((op, i) => {
            msg += `\n▸ *${op.texto}*`;
        });
    }
    if (rodape) msg += `\n\n_${rodape}_`;
    return { text: msg };
}

function criarLista(texto, tituloBotao, secoes = []) {
    // Gera texto com seções e itens numerados
    let msg = texto;
    let contador = 1;
    for (const secao of secoes) {
        msg += `\n\n*${secao.titulo}*`;
        for (const item of secao.itens) {
            const desc = item.descricao ? ` — ${item.descricao}` : "";
            msg += `\n${contador}️⃣ ${item.titulo}${desc}`;
            contador++;
        }
    }
    return { text: msg };
}

// -----------------------------------------------------

export function criarFluxoConversa({ diretorioDados = "/app/data", urlBanco, logger = console, chaveGemini = "" }) {
    // Inicializa assistente de IA (classificador de intencoes)
    const assistenteIA = criarAssistenteIA(chaveGemini, logger);
    // --------- Armazenamento de Estado ----------
    const ARQUIVO_ESTADO = path.join(diretorioDados, "estado_fluxo_conversa.json");
    let estado = {};

    // Tenta carregar estado anterior
    try { estado = JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, "utf8")); } catch { estado = {}; }

    function salvarEstado() {
        try { fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado)); } catch { }
    }

    function obterUsuario(chaveUsuario) {
        // Inicializa novo usuário se não existir
        return estado[chaveUsuario] || (estado[chaveUsuario] = { etapa: "NOVO", dados_temporarios: {} });
    }

    function atualizarUsuario(chaveUsuario, atualizacao) {
        estado[chaveUsuario] = { ...(estado[chaveUsuario] || { etapa: "NOVO", dados_temporarios: {} }), ...atualizacao };
        salvarEstado();
    }

    // --- Função para enviar e-mail de cancelamento ---
    async function enviarEmailCancelamento({ aluno, dataAlvo, telefone }) {
        const usuario = process.env.GMAIL_USER;
        const senha = process.env.GMAIL_APP_PASSWORD;
        const destinatario = process.env.CAE_EMAIL || usuario; // Se não tiver CAE, manda pra si mesmo

        if (!usuario || !senha) {
            logger.error("Credenciais de e-mail ausentes no ENV.");
            return { ok: false, motivo: "SEM_CREDENCIAIS", erro: "GMAIL_USER ou PASS vazios" };
        }

        const transportador = nodemailer.createTransport({
            service: "gmail",
            auth: { user: usuario, pass: senha },
        });

        const dataStr = formatarDDMM(dataAlvo);
        const diaSemana = NOMES_DIAS_SEMANA[dataAlvo.getDay()];
        const nome = aluno.nome || "Aluno";
        const prontBase = String(aluno.prontuario || "").toUpperCase();
        const prontCompleto = prontBase.startsWith("PT") ? prontBase : `PT${prontBase}`;
        const prontNumerico = apenasDigitos(prontBase);

        const assunto = `Cancelamento de almoço - ${prontCompleto} - ${dataStr}`;

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

        const textoSimples = `Solicitação de cancelamento:\nAluno: ${nome}\nProntuário: ${prontNumerico}\nData: ${dataStr}`;

        try {
            await transportador.sendMail({
                from: `"Assistente de Almoço" <${usuario}>`,
                to: destinatario,
                subject: assunto,
                text: textoSimples,
                html: html,
            });
            return { ok: true, dataAlvo };

        } catch (err) {
            const erroStr = String(err);
            logger.error("Erro detalhado do Nodemailer:", erroStr);
            return { ok: false, motivo: "ERRO_SMTP", erro: erroStr };
        }
    }

    // --------- BANCO DE DADOS ----------
    if (!urlBanco) throw new Error("DATABASE_URL vazio. Defina env DATABASE_URL.");
    const pool = new Pool({
        connectionString: urlBanco,
        max: 5,
        idleTimeoutMillis: 60_000,
        connectionTimeoutMillis: 10_000,
        statement_timeout: 30_000,
    });

    async function conectarBanco(funcao) {
        const conexao = await pool.connect();
        try { return await funcao(conexao); } finally { conexao.release(); }
    }

    // --- Queries ---
    async function verificarSeDiaJaCancelado(c, alunoId, dataAlvo) {
        const iso = dataIsoUTC(dataAlvo);
        const { rows } = await c.query(
            `SELECT 1 FROM pedido 
         WHERE aluno_id = $1 AND dia_pedido = $2
           AND (motivo ILIKE '%cancelamento%' OR motivo ILIKE '%CANCELADO%')
         LIMIT 1`,
            [alunoId, iso]
        );
        return rows.length > 0;
    }

    async function verificarPedidoExistente(c, alunoId, dataAlvo) {
        const iso = dataIsoUTC(dataAlvo);
        const { rows } = await c.query(
            `SELECT 1 FROM pedido WHERE aluno_id = $1 AND dia_pedido = $2 LIMIT 1`,
            [alunoId, iso]
        );
        return rows.length > 0;
    }

    async function buscarAlunoPorTelefone(c, telefone) {
        const telLimpo = apenasDigitos(telefone);
        if (!telLimpo) return null;

        // 1. Busca exata (mais rapido)
        const { rows } = await c.query(
            `SELECT a.*
             FROM aluno a
             JOIN contato ctt ON ctt.aluno_id = a.id
             WHERE regexp_replace(ctt.telefone, '\\D', '', 'g') = $1
             LIMIT 1`, [telLimpo]
        );
        if (rows[0]) return rows[0];

        // 2. Se o telefone começa com 55 (Brasil), tenta sem o 55
        if (telLimpo.startsWith("55") && telLimpo.length > 10) {
            const semPais = telLimpo.slice(2);
            const { rows: rows2 } = await c.query(
                `SELECT a.*
                 FROM aluno a
                 JOIN contato ctt ON ctt.aluno_id = a.id
                 WHERE regexp_replace(ctt.telefone, '\\D', '', 'g') = $1
                 LIMIT 1`, [semPais]
            );
            if (rows2[0]) return rows2[0];
        }

        // 3. Tenta adicionando 55 na frente (caso o JID venha sem DDI)
        if (!telLimpo.startsWith("55") && telLimpo.length >= 10) {
            const comPais = "55" + telLimpo;
            const { rows: rows3 } = await c.query(
                `SELECT a.*
                 FROM aluno a
                 JOIN contato ctt ON ctt.aluno_id = a.id
                 WHERE regexp_replace(ctt.telefone, '\\D', '', 'g') = $1
                 LIMIT 1`, [comPais]
            );
            if (rows3[0]) return rows3[0];
        }

        // 4. Busca pelos ultimos 8-9 digitos (nucleo do numero, ignorando DDI+DDD)
        if (telLimpo.length >= 8) {
            const sufixo = telLimpo.slice(-9); // Pega os ultimos 9 digitos
            const { rows: rows4 } = await c.query(
                `SELECT a.*
                 FROM aluno a
                 JOIN contato ctt ON ctt.aluno_id = a.id
                 WHERE regexp_replace(ctt.telefone, '\\D', '', 'g') LIKE '%' || $1
                 LIMIT 1`, [sufixo]
            );
            if (rows4[0]) return rows4[0];
        }

        return null;
    }

    // [NOVO QUERY] Registra pedido de cancelamento direto no histórico
    async function registrarCancelamentoDireto(c, alunoId, dataAlvo, motivo) {
        const dataIso = dataIsoUTC(dataAlvo);

        // 1. Tenta atualizar registro existente
        const resultadoUpdate = await c.query(
            `UPDATE pedido SET motivo = $3 WHERE aluno_id = $1 AND dia_pedido = $2`,
            [alunoId, dataIso, motivo]
        );

        // 2. Se não existir, insere novo
        if (resultadoUpdate.rowCount === 0) {
            await c.query(
                `INSERT INTO pedido (aluno_id, dia_pedido, motivo) VALUES ($1, $2, $3)`,
                [alunoId, dataIso, motivo]
            );
        }
    }

    async function buscarAlunoPorProntuario(c, prontuario) {
        const q = `SELECT * FROM aluno WHERE prontuario = $1 LIMIT 1`;
        const { rows } = await c.query(q, [prontuario]);
        return rows[0] || null;
    }

    // Verifica se dois telefones sao equivalentes (compara os ultimos 9 digitos)
    function telefonesEquivalentes(tel1, tel2) {
        const d1 = apenasDigitos(tel1);
        const d2 = apenasDigitos(tel2);
        if (d1 === d2) return true;
        // Compara os ultimos 9 digitos (nucleo brasileiro sem DDI+DDD)
        if (d1.length >= 9 && d2.length >= 9) {
            return d1.slice(-9) === d2.slice(-9);
        }
        return false;
    }

    async function vincularAlunoContato(c, { prontuario, telefone }) {
        const aluno = await buscarAlunoPorProntuario(c, prontuario);
        if (!aluno) return { ok: false, motivo: "NAO_ENCONTRADO" };

        // Protecao: nao salvar LIDs como telefone
        if (!eTelefoneValido(telefone)) {
            logger.warn(`[LID] Tentativa de vincular com LID em vez de telefone: ${telefone}`);
            return { ok: false, motivo: "TELEFONE_INVALIDO" };
        }

        // Busca TODOS os contatos vinculados (sem LIMIT 1) para permitir múltiplos IDs (ex: LID e Número)
        const { rows } = await c.query(
            `SELECT id, telefone FROM contato WHERE aluno_id = $1`, [aluno.id]
        );

        if (rows.length) {
            // Verifica se este ID específico (telefone/LID) já está na lista
            const jaVinculado = rows.some(r => telefonesEquivalentes(r.telefone, telefone));

            if (!jaVinculado) {
                // É um novo ID para o mesmo aluno (ex: mudou de Número para LID). 
                // ADICIONAMOS em vez de substituir, para que ambos funcionem.
                logger.info(`[MULTI-ID] Adicionando novo ID para aluno ${aluno.id}: ${telefone}`);
                await c.query(
                    `INSERT INTO contato (aluno_id, telefone) VALUES ($1,$2)`,
                    [aluno.id, telefone]
                );
                return { ok: true, alunoId: aluno.id, aluno, migrado: true };
            }

            // Já existe esse ID. Tudo certo.
            return { ok: true, alunoId: aluno.id, aluno, migrado: false };
        }

        // Primeiro vínculo
        await c.query(
            `INSERT INTO contato (aluno_id, telefone) VALUES ($1,$2)`, [aluno.id, telefone]
        );
        return { ok: true, alunoId: aluno.id, aluno };
    }

    async function salvarPreferenciasDias(c, alunoId, dias = []) {
        await c.query(`DELETE FROM preferencia_dia WHERE aluno_id=$1`, [alunoId]);
        if (!dias.length) return;
        const valores = dias.map((d, i) => `($1,$${i + 2})`).join(",");
        await c.query(
            `INSERT INTO preferencia_dia (aluno_id, dia_semana) VALUES ${valores}`,
            [alunoId, ...dias]
        );
    }

    async function salvarBloqueios(c, alunoId, nomes = []) {
        for (const nome of nomes.map(limparTexto).filter(Boolean)) {
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

    async function removerBloqueios(c, alunoId, nomes = []) {
        for (const nome of nomes.map(limparTexto).filter(Boolean)) {
            await c.query(
                `DELETE FROM prato_bloqueado WHERE aluno_id=$1 AND lower(nome)=lower($2)`,
                [alunoId, nome]
            );
        }
    }

    async function limparTodosBloqueios(c, alunoId) {
        await c.query(`DELETE FROM prato_bloqueado WHERE aluno_id=$1`, [alunoId]);
    }

    async function alterarStatusAtivo(c, alunoId, ativo) {
        await c.query(`UPDATE aluno SET ativo=$2 WHERE id=$1`, [alunoId, !!ativo]);
    }

    async function obterDiasPreferidos(c, alunoId) {
        const { rows } = await c.query(
            `SELECT dia_semana FROM preferencia_dia WHERE aluno_id = $1 ORDER BY dia_semana`, [alunoId]
        );
        return rows.map(r => r.dia_semana);
    }

    async function obterBloqueios(c, alunoId) {
        const { rows } = await c.query(
            `SELECT nome FROM prato_bloqueado WHERE aluno_id = $1 ORDER BY nome`, [alunoId]
        );
        return rows.map(r => r.nome);
    }

    async function buscarUltimoPedido(c, alunoId) {
        const { rows } = await c.query(
            `SELECT dia_pedido, motivo FROM pedido
        WHERE aluno_id = $1 AND motivo NOT ILIKE '%anteriormente%' AND motivo NOT LIKE '%Final%'
        ORDER BY dia_pedido DESC, id DESC LIMIT 1`, [alunoId]
        );
        return rows[0] || null;
    }

    async function buscarUltimosPedidos(c, alunoId) {
        const { rows } = await c.query(
            `SELECT dia_pedido, motivo FROM pedido
        WHERE aluno_id = $1 AND dia_pedido >= (CURRENT_DATE - INTERVAL '7 days')
          AND motivo NOT ILIKE '%anteriormente%' AND motivo NOT LIKE '%Final%'
        ORDER BY dia_pedido DESC, id DESC`, [alunoId]
        );
        return rows;
    }

    // Busca pedidos da semana visualizada (seg a sex) para a tabela visual
    // Se for Sab/Dom, busca da PRÓXIMA semana (mesma lógica de gerarCabecalho)
    async function buscarPedidosSemanaAtual(c, alunoId) {
        const agora = new Date();
        const segunda = obterSegundaDaSemana(agora);
        if (agora.getDay() === 0 || agora.getDay() === 6) {
            segunda.setDate(segunda.getDate() + 7);
        }
        const sexta = new Date(segunda);
        sexta.setDate(segunda.getDate() + 4);
        const { rows } = await c.query(
            `SELECT dia_pedido, motivo FROM pedido
             WHERE aluno_id = $1
               AND dia_pedido >= $2
               AND dia_pedido <= $3
               AND motivo NOT ILIKE '%anteriormente%'
               AND motivo NOT LIKE '%Final%'
             ORDER BY dia_pedido ASC, id DESC`,
            [alunoId, dataIsoUTC(segunda), dataIsoUTC(sexta)]
        );
        return rows;
    }

    async function obterPratoAtual(c) {
        // Nova Lógica:
        // Antes das 12:30 -> Tenta pegar cardápio de HOJE
        // Depois das 12:30 -> Tenta pegar cardápio do PRÓXIMO DIA ÚTIL
        // Usa horário de São Paulo explicitamente para não depender de TZ do container
        const agoraSP = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Sao_Paulo" }));
        const horaSP = agoraSP.getHours();
        const minutoSP = agoraSP.getMinutes();

        let dataAlvo = new Date(agoraSP);

        // Se já passou das 12:30 em SP, foca em amanhã
        if (horaSP > 12 || (horaSP === 12 && minutoSP >= 30)) {
            dataAlvo.setDate(dataAlvo.getDate() + 1);
        }

        // Pula fim de semana (Sáb/Dom -> Seg)
        while (dataAlvo.getDay() === 0 || dataAlvo.getDay() === 6) {
            dataAlvo.setDate(dataAlvo.getDate() + 1);
        }

        const iso = dataIsoUTC(dataAlvo);

        // 1. Prioridade: Busca exata pela data calculada (ideal)
        const { rows } = await c.query(
            `SELECT dia_referente, prato_nome FROM proximo_prato WHERE dia_referente = $1 LIMIT 1`,
            [iso]
        );
        if (rows[0]) return rows[0];

        // 2. Se não tiver no banco, retorna um placeholder para não mostrar prato velho
        // O usuário prefere ver "Sexta: Ainda não divulgado" do que "Quinta: Kibe" (que confunde)
        return {
            dia_referente: dataAlvo, // Mantém a data correta (amanhã/hoje)
            prato_nome: "Ainda não divulgado"
        };
    }

    // --- Menu Principal ---
    function menuPrincipalInterativo(aluno, pratoAtual, dadosSemana = null) {
        const cabecalho = gerarCabecalho(aluno, pratoAtual, dadosSemana);

        const menu = cabecalho +
            "*Como posso ajudar?*\n" +
            "Responda com o *número* ou o *nome* do comando:\n\n" +
            "*Ações Rápidas*\n" +
            "1. Cancelar Almoço\n" +
            "2. Meu Status\n" +
            "3. Histórico\n\n" +
            "*Configurações*\n" +
            "4. Definir Dias\n" +
            "5. Bloquear Pratos\n" +
            "6. Desbloquear Pratos\n" +
            "7. Ativar/Desativar\n" +
            "8. Guia / Ajuda";

        return { text: menu };
    }


    // --- Menu Guia (Novo) ---
    function menuGuia() {
        return criarTexto(
            "*Guia do Bot IFSP Food* 🤖\n\n" +

            "*Legenda dos Dias:*\n" +
            "✅ *Já Pedi:* O bot já fez o pedido no SUAP.\n" +
            "📅 *Vou Comer:* Está agendado, o bot vai pedir no dia.\n" +
            "❌ *Não Vou:* Você não almoça ou cancelou este dia.\n" +
            "⚠️ *Atenção:* Houve algum erro, verifique no SUAP.\n\n" +

            "*Comandos Principais:*\n" +
            "🔹 *Cancelar Almoço:* Cancela o pedido de um dia específico.\n" +
            "🔹 *Definir Dias:* Escolha seus dias padrão de almoço (ex: seg, qua).\n" +
            "🔹 *Bloquear Prato:* Impedir pedidos se tiver certo prato (ex: peixe).\n" +
            "🔹 *Ativar/Desativar:* Liga ou desliga o robô temporariamente.\n\n" +

            "Dica: Digite comandos diretos como *cancelar amanha* ou *não como peixe*."
        );
    }

    const MENSAGEM_BOAS_VINDAS = criarTexto(
        "*IFSP Pirituba - Assistente de Almoço*\n\n" +
        "Esse bot *pede seu almoço automaticamente* no site do SUAP todo dia de manhã!\n\n" +
        "Você só precisa:\n" +
        "1. Vincular seu prontuário IFSP\n" +
        "2. Escolher quais dias da semana você almoça\n\n" +
        "Depois disso, o bot cuida do resto. Se não quiser comer algum dia, é só cancelar pelo bot.\n\n" +
        "Envie *continuar* para começar o cadastro."
    );

    // --- Texto de Dias da Semana ---
    function menuDiasSemana(motivo) {
        return criarTexto(
            (motivo || "Escolha os dias da semana:") + "\n\n" +
            "Em quais dias você almoça no IFSP?\n" +
            "O bot vai pedir seu almoço *automaticamente* nesses dias.\n\n" +
            "Escreva os dias separados por vírgula:\n\n" +
            "Dias válidos: seg, ter, qua, qui, sex"
        );
    }

    // --------- HANDLER PRINCIPAL (LÓGICA DO BOT) ----------
    async function processarTexto(jid, textoBruto, isButton = false, jaUsouIA = false) {
        // Se for botão, o textoBruto é o ID do botão.
        const texto = limparTexto(textoBruto);
        if (!texto) return null;

        const chaveUsuario = jidParaTelefone(jid);
        // Log para debug de JID (fix bug duplicidade)
        if (texto !== "poll_vote") {
            logger.info(`[BOT] Processando: JID=${jid} -> Tel=${chaveUsuario}`);
        }

        const usuario = obterUsuario(chaveUsuario);
        const telefone = chaveUsuario;

        // Busca dados no banco (queries em paralelo para velocidade)
        // Busca dados no banco (queries em paralelo para velocidade e robustez)
        let aluno = null, pratoAtual = null, dadosSemana = null;
        try {
            const { aluno: a, pratoAtual: pa, dadosSemana: ds } = await conectarBanco(async c => {
                // Busca aluno e prato em paralelo (independentes)
                // Se um falhar, não deve derrubar o bot inteiro (idealmente)
                // Mas aqui usamos Promise.all, então se um der erro, cai no catch.
                const [a, pa] = await Promise.all([
                    buscarAlunoPorTelefone(c, telefone).catch(e => { logger.error(`[DB] Erro buscarAluno: ${e}`); return null; }),
                    obterPratoAtual(c).catch(e => { logger.error(`[DB] Erro obterPrato: ${e}`); return null; })
                ]);
                let ds = null;
                if (a) {
                    try {
                        const [pedidosSemana, diasPreferidos] = await Promise.all([
                            buscarPedidosSemanaAtual(c, a.id),
                            obterDiasPreferidos(c, a.id)
                        ]);
                        ds = { pedidos: pedidosSemana, diasPreferidos };
                    } catch (e) {
                        logger.error(`[DB] Erro ao buscar dados da semana: ${e}`);
                        // Continua sem histórico se der erro, melhor que travar.
                    }
                }
                return { aluno: a, pratoAtual: pa, dadosSemana: ds };
            });
            aluno = a; pratoAtual = pa; dadosSemana = ds;

        } catch (e) {
            logger.error(`[CRITICAL] Falha total ao buscar dados no banco: ${e}`);
            // Se falhar banco, tenta responder algo genérico ou ignora para não crashar
            return { text: "⚠️ O sistema está instável no momento. Tente novamente em alguns instantes." };
        }

        // Se não achou aluno, força fluxo de cadastro (impede menu principal)
        if (!aluno) {
            // Mantém o fluxo normal que já lida com !aluno lá embaixo
        } else {
            // Se achou o aluno mas o estado local não tem ID, atualiza
            if (!usuario.aluno_id) {
                atualizarUsuario(chaveUsuario, { aluno_id: aluno.id, etapa: "MENU_PRINCIPAL", dados_temporarios: {} });
            }
        }

        const textoNorm = normalizar(texto);

        // CORREÇÃO: Verifica se é usuário novo ANTES de processar comandos globais
        // Isso impede que "oi" abra o menu para quem nunca se cadastrou
        if (!aluno) {
            // ... lógica de cadastro (mantida igual, só movida de ordem mentalmente)
            // Mas como o código original tem um bloco gigante "if (!aluno)", 
            // basta garantir que o bloco "Atalhos Globais" NÃO rode se aluno for null.
        }

        // -- Atalhos Globais (REMOVIDO "oi", "ola" para deixar a IA responder) --
        // Apenas comandos unívocos ficam aqui.
        if (["ajuda", "menu", "help", "comandos"].includes(textoNorm)) {
            atualizarUsuario(chaveUsuario, { etapa: "MENU_PRINCIPAL", dados_temporarios: {} });
            return menuPrincipalInterativo(aluno || null, pratoAtual, dadosSemana);
        }

        // -- Atalhos Numéricos do Menu (1-8) --
        const MAPA_NUMEROS = {
            "1": "cancelar", "2": "status", "3": "historico",
            "4": "preferencia", "5": "bloquear", "6": "desbloquear",
            "7": null, "8": "guia" // 7 é tratado como toggle abaixo
        };
        if (textoNorm === "7" && usuario.etapa === "MENU_PRINCIPAL") {
            // Toggle: se está ativo → desativa, se inativo → ativa
            return processarTexto(jid, aluno?.ativo ? "desativar" : "ativar");
        }
        if (MAPA_NUMEROS[textoNorm] && usuario.etapa === "MENU_PRINCIPAL") {
            return processarTexto(jid, MAPA_NUMEROS[textoNorm]);
        }

        if (textoNorm === "guia" || textoNorm === "ajuda" || textoNorm === "como funciona") {
            return menuGuia();
        }

        if (textoNorm === "status" || textoNorm === "meu status" || textoNorm === "cadastro") {
            if (!aluno) return criarTexto(gerarCabecalho(null, null, pratoAtual) + "Seu número ainda *não está vinculado*. Envie: *CONTINUAR*.");

            const bloqueiosUsuario = await conectarBanco(c => obterBloqueios(c, aluno.id));

            const diasTxt = dadosSemana?.diasPreferidos?.length ? formatarDiasHumanos(dadosSemana.diasPreferidos) : "nenhum";
            const bloqueiosTxt = bloqueiosUsuario.length ? bloqueiosUsuario.join(", ") : "nenhum";

            const msg = gerarCabecalho(aluno, pratoAtual, dadosSemana) +
                "*Status do seu cadastro*\n\n" +
                `• Cadastro ativo: *${aluno.ativo ? "Sim" : "Não"}*\n` +
                `• Dias cadastrados: *${diasTxt}*\n` +
                `• Pratos bloqueados: *${bloqueiosTxt}*\n`;

            return criarTexto(msg);
        }

        if (textoNorm.includes("historico")) {
            if (!aluno) return criarTexto("Cadastro não encontrado.");

            const pedidos = await conectarBanco(c => buscarUltimosPedidos(c, aluno.id));
            let corpo = "Histórico de pedidos (7 dias)\n\n" + (pedidos.length ? "" : "Não encontrei registros recentes.");

            const linhas = pedidos.map(p => {
                const data = formatarDataBR(p.dia_pedido);
                const { tipo, detalhe } = classificarMotivo(p.motivo);
                let desc = tipo === "PEDIU_OK" ? "[OK]" : (tipo === "NAO_PEDIU" ? "[!]" : "[X]");
                return `• ${data}: ${desc} ${detalhe || ""}`;
            });
            corpo += linhas.join("\n");

            return criarTexto(gerarCabecalho(aluno, pratoAtual, dadosSemana) + corpo);
        }

        // ================= FLUXO DE CADASTRO =================
        if (!aluno) {
            if (usuario.etapa === "AGUARDANDO_PRONTUARIO") {
                let pront = limparTexto(texto).replace(/\s+/g, "").toUpperCase().replace(/^PT/, "").replace(/\D/g, "");
                if (!/^\d{5,12}$/.test(pront)) {
                    return criarTexto("Formato invalido. Digite apenas números do prontuário (ex: 3029791).");
                }
                atualizarUsuario(chaveUsuario, { etapa: "AGUARDANDO_DIAS", dados_temporarios: { prontuario: pront } });
                return menuDiasSemana("Prontuário recebido! Agora escolha os *dias da semana* que voce almoca:");
            }

            if (textoNorm.includes("continuar") || textoNorm === "continuar_cadastro") {
                atualizarUsuario(chaveUsuario, { etapa: "AGUARDANDO_PRONTUARIO", dados_temporarios: {} });
                return criarTexto("*Cadastro Inicial*\n\nPor favor, digite seu *prontuario IFSP* (apenas números).");
            }

            if (usuario.etapa === "AGUARDANDO_CONSENTIMENTO") {
                return criarBotoes("Quando quiser começar, é só clicar abaixo.", "", [{ id: "continuar_cadastro", texto: "Continuar" }]);
            }

            if (usuario.etapa === "NOVO") {
                atualizarUsuario(chaveUsuario, { etapa: "AGUARDANDO_CONSENTIMENTO", dados_temporarios: {} });
                return MENSAGEM_BOAS_VINDAS;
            }

            if (usuario.etapa === "AGUARDANDO_DIAS") {
                const dias = interpretarListaDias(texto);
                if (!dias.length) return criarTexto("Não entendi. Digite os dias (ex: seg, ter).");

                const pront = usuario.dados_temporarios?.prontuario;

                const res = await conectarBanco(async c => {
                    const vinculo = await vincularAlunoContato(c, { prontuario: pront, telefone: telefone });
                    if (!vinculo.ok) return vinculo;
                    await salvarPreferenciasDias(c, vinculo.alunoId, dias);
                    await alterarStatusAtivo(c, vinculo.alunoId, true);
                    return vinculo;
                });

                if (!res.ok) {
                    if (res.motivo === "NAO_ENCONTRADO") return criarBotoes(
                        "Prontuário não encontrado na base.\n\n" +
                        "Se você acha que deveria estar cadastrado, procure a sala do *3° Redes* para regularizar.",
                        "", [{ id: "continuar_cadastro", texto: "Tentar De Novo" }]
                    );
                    if (res.motivo === "JA_VINCULADO") return criarTexto("Prontuário já vinculado a outro número.");
                    return criarTexto("Erro no sistema.");
                }

                atualizarUsuario(chaveUsuario, { etapa: "MENU_PRINCIPAL", dados_temporarios: {}, aluno_id: res.alunoId });
                return menuPrincipalInterativo({ nome: res.aluno.nome }, pratoAtual);
            }
            return MENSAGEM_BOAS_VINDAS;
        }

        // ================= ALUNO LOGADO =================
        const alunoAtual = aluno;

        if (usuario.etapa === "DEFINIR_DIAS") {
            const dias = interpretarListaDias(texto);
            if (!dias.length) return criarTexto("Selecione pelo menos um dia.");
            await conectarBanco(c => salvarPreferenciasDias(c, alunoAtual.id, dias));
            atualizarUsuario(chaveUsuario, { etapa: "MENU_PRINCIPAL", dados_temporarios: {} });
            return menuPrincipalInterativo(alunoAtual, pratoAtual, dadosSemana);
        }

        if (usuario.etapa === "DEFINIR_BLOQUEIOS") {
            const itens = texto.split(/[,;\n]+/).map(limparTexto).filter(Boolean);
            if (!itens.length) return criarTexto("Envie os nomes dos pratos (ex: peixe, figado).");
            await conectarBanco(c => salvarBloqueios(c, alunoAtual.id, itens));

            // Pede sugestões ao Gemini (não bloqueia se falhar)
            try {
                const sugestoes = await assistenteIA.sugerirBloqueios(itens);
                if (sugestoes.length > 0) {
                    atualizarUsuario(chaveUsuario, {
                        etapa: "CONFIRMAR_SUGESTOES_BLOQUEIO",
                        dados_temporarios: { sugestoes, itensBloqueados: itens }
                    });
                    const listaSugestoes = sugestoes.map((s, i) => `${i + 1}. ${s}`).join("\n");
                    return criarTexto(
                        `*Bloqueios adicionados:* ${itens.join(", ")}\n\n` +
                        `Baseado no que você bloqueou, talvez queira bloquear também:\n\n` +
                        `${listaSugestoes}\n\n` +
                        `Responda com os *números* das sugestões (ex: 1,3) ou *não* para pular.`
                    );
                }
            } catch (e) {
                logger.warn(`[BLOQUEIO] Erro ao buscar sugestões IA: ${e.message}`);
            }

            atualizarUsuario(chaveUsuario, { etapa: "MENU_PRINCIPAL", dados_temporarios: {} });
            return criarTexto(`*Bloqueios adicionados:* ${itens.join(", ")}`);
        }

        if (usuario.etapa === "CONFIRMAR_SUGESTOES_BLOQUEIO") {
            const sugestoes = usuario.dados_temporarios?.sugestoes || [];
            const textoResp = textoNorm;

            // Se o aluno quer pular
            if (["nao", "não", "n", "pular", "0"].includes(textoResp)) {
                atualizarUsuario(chaveUsuario, { etapa: "MENU_PRINCIPAL", dados_temporarios: {} });
                return criarTexto("Ok, nenhuma sugestão adicionada.");
            }

            // Tenta interpretar números (ex: "1,3" ou "1 3" ou "1, 2, 3")
            const numeros = textoResp.match(/\d+/g);
            if (numeros && numeros.length > 0) {
                const selecionados = numeros
                    .map(n => parseInt(n, 10))
                    .filter(n => n >= 1 && n <= sugestoes.length)
                    .map(n => sugestoes[n - 1]);

                if (selecionados.length > 0) {
                    await conectarBanco(c => salvarBloqueios(c, alunoAtual.id, selecionados));
                    atualizarUsuario(chaveUsuario, { etapa: "MENU_PRINCIPAL", dados_temporarios: {} });
                    return criarTexto(`*Bloqueios adicionados:* ${selecionados.join(", ")}`);
                }
            }

            // Se digitou texto livre (ex: "tilapia, merluza"), salva direto
            const itensTexto = texto.split(/[,;\n]+/).map(limparTexto).filter(Boolean);
            if (itensTexto.length > 0) {
                await conectarBanco(c => salvarBloqueios(c, alunoAtual.id, itensTexto));
                atualizarUsuario(chaveUsuario, { etapa: "MENU_PRINCIPAL", dados_temporarios: {} });
                return criarTexto(`*Bloqueios adicionados:* ${itensTexto.join(", ")}`);
            }

            atualizarUsuario(chaveUsuario, { etapa: "MENU_PRINCIPAL", dados_temporarios: {} });
            return criarTexto("Ok, nenhuma sugestão adicionada.");
        }

        if (usuario.etapa === "REMOVER_BLOQUEIOS") {
            const textoLimpo = textoNorm;
            if (textoLimpo === "todos" || textoLimpo === "tudo" || textoLimpo === "limpar") {
                await conectarBanco(c => limparTodosBloqueios(c, alunoAtual.id));
                atualizarUsuario(chaveUsuario, { etapa: "MENU_PRINCIPAL", dados_temporarios: {} });
                return criarTexto("Todos os bloqueios foram removidos.");
            }
            const itens = texto.split(/[,;\n]+/).map(limparTexto).filter(Boolean);
            if (!itens.length) return criarTexto("Envie os nomes dos pratos para desbloquear (ex: peixe).");
            await conectarBanco(c => removerBloqueios(c, alunoAtual.id, itens));
            atualizarUsuario(chaveUsuario, { etapa: "MENU_PRINCIPAL", dados_temporarios: {} });
            return criarTexto(`*Bloqueios removidos:* ${itens.join(", ")}`);
        }

        // -- CONFIRMAÇÃO DE CANCELAMENTO --
        if (usuario.etapa === "CONFIRMAR_CANCELAMENTO") {
            let acao = "INCONCLUSIVO";
            if (["nao", "não", "n", "cancelar_abortar"].includes(textoNorm)) acao = "NAO";
            else if (["sim", "s", "ok", "confirmar_cancelamento", "simm"].includes(textoNorm)) acao = "SIM";
            else acao = await assistenteIA.interpretarConfirmacao(texto);

            // Se clicou em Não/Cancelar
            if (acao === "NAO") {
                atualizarUsuario(chaveUsuario, { etapa: "MENU_PRINCIPAL", dados_temporarios: {} });
                return criarTexto("Cancelamento abortado.");
            }

            // Se clicou em Sim
            if (acao === "SIM") {
                const d = new Date(usuario.dados_temporarios?.dataCancelamento);
                const metodo = usuario.dados_temporarios?.metodo;
                const dataStr = `${NOMES_DIAS_SEMANA[d.getDay()]} ${formatarDDMM(d)}`;
                const isoHoje = dataIsoUTC(d);

                if (metodo === "DIRETO") {
                    const motivo = `CANCELADO_DIRETAMENTE: Aluno solicitou via Bot.`;
                    await conectarBanco(c => registrarCancelamentoDireto(c, alunoAtual.id, d, motivo));
                    atualizarUsuario(chaveUsuario, { etapa: "MENU_PRINCIPAL", dados_temporarios: {}, ultimaDataCancelamento: isoHoje });
                    return criarTexto(`Cancelamento registrado para ${dataStr} (Python não fará o pedido).`);
                } else {
                    const resEmail = await enviarEmailCancelamento({ aluno: alunoAtual, dataAlvo: d, telefone });
                    if (!resEmail.ok) return criarTexto(`Erro ao enviar e-mail: ${resEmail.erro}`);

                    const motivo = `CANCELAMENTO_EMAIL: Enviado para CAE em ${new Date().toLocaleString('pt-BR')}`;
                    await conectarBanco(c => registrarCancelamentoDireto(c, alunoAtual.id, d, motivo));

                    atualizarUsuario(chaveUsuario, { etapa: "MENU_PRINCIPAL", dados_temporarios: {}, ultimaDataCancelamento: isoHoje });
                    return criarTexto(`Cancelamento enviado para ${dataStr} via e-mail.`);
                }
            }

            // Se falou outra coisa, ignora ou repete
            return criarBotoes(
                "Por favor, confirme se deseja cancelar.",
                "Confirmação",
                [{ id: "confirmar_cancelamento", texto: "Sim, Cancelar" }, { id: "cancelar_abortar", texto: "Não" }]
            );
        }

        // -- CONFIRMAÇÃO DE CANCELAMENTO AO DESATIVAR --
        if (usuario.etapa === "CONFIRMAR_CANCELAMENTO_DESATIVAR") {
            const diasStrs = usuario.dados_temporarios?.dias || [];
            
            let acao = "INCONCLUSIVO";
            if (["nao", "não", "n", "nao_cancelar"].includes(textoNorm)) acao = "NAO";
            else if (["sim", "s", "ok", "cancelar_todos", "simm"].includes(textoNorm)) acao = "SIM";
            else acao = await assistenteIA.interpretarConfirmacao(texto);

            if (acao === "NAO") {
                atualizarUsuario(chaveUsuario, { etapa: "MENU_PRINCIPAL", dados_temporarios: {} });
                return criarTexto("Certo, seus pedidos já feitos para esta semana continuam de pé.");
            }
            if (acao === "SIM") {
               let sucessoMsg = [];
               for (const dStr of diasStrs) {
                   const dataAlvo = new Date(dStr);
                   const resEmail = await enviarEmailCancelamento({ aluno: alunoAtual, dataAlvo, telefone });
                   if (resEmail.ok) {
                       const motivo = `CANCELAMENTO_EMAIL: Enviado p/ CAE (Desativação) em ${new Date().toLocaleString('pt-BR')}`;
                       await conectarBanco(c => registrarCancelamentoDireto(c, alunoAtual.id, dataAlvo, motivo));
                       sucessoMsg.push(`${NOMES_DIAS_CURTO[dataAlvo.getDay()]}`);
                   }
               }
               atualizarUsuario(chaveUsuario, { etapa: "MENU_PRINCIPAL", dados_temporarios: {} });
               if (sucessoMsg.length) {
                   return criarTexto(`Cancelamentos solicitados via e-mail para: ${sucessoMsg.join(", ")}`);
               } else {
                   return criarTexto(`Ocorreu um erro ao gerar os e-mails de cancelamento.`);
               }
            }

            return criarBotoes(
                "Por favor, confirme se deseja cancelar os almoços já pedidos.",
                "Cancelamento em Lote",
                [ { id: "cancelar_todos", texto: "Cancelar todos" }, { id: "nao_cancelar", texto: "Não cancelar" } ]
            );
        }

        // --- CANCELAMENTO (INÍCIO) ---
        async function processarFluxoCancelamentoDia(dataAlvo) {
            const numeroDiaAlvo = dataAlvo.getDay();
            const diasPreferidos = await conectarBanco(c => obterDiasPreferidos(c, alunoAtual.id));
            const diasPreferidosNums = diasPreferidos.length > 0 ? diasPreferidos : [1, 2, 3, 4, 5];

            if (!diasPreferidosNums.includes(numeroDiaAlvo)) {
                atualizarUsuario(chaveUsuario, { etapa: "MENU_PRINCIPAL", dados_temporarios: {} });
                return criarTexto(`Você não está cadastrado ou configurado para almoçar neste dia da semana.`);
            }

            const dataStr = `${NOMES_DIAS_SEMANA[dataAlvo.getDay()]} ${formatarDDMM(dataAlvo)}`;

            const jaFoiCancelado = await conectarBanco(c => verificarSeDiaJaCancelado(c, alunoAtual.id, dataAlvo));
            if (jaFoiCancelado) {
                 atualizarUsuario(chaveUsuario, { etapa: "MENU_PRINCIPAL", dados_temporarios: {} });
                 return criarTexto(`O almoço de *${dataStr}* já estava cancelado.`);
            }

            const pedidoJaExiste = await conectarBanco(c => verificarPedidoExistente(c, alunoAtual.id, dataAlvo));
            let metodo = pedidoJaExiste ? "EMAIL" : "DIRETO";

            atualizarUsuario(chaveUsuario, { etapa: "CONFIRMAR_CANCELAMENTO", dados_temporarios: { dataCancelamento: dataAlvo, metodo } });

            if (metodo === "DIRETO") {
                return criarBotoes(
                    `Deseja CANCELAR o almoço de *${dataStr}*?\nAinda dá tempo de cancelar no sistema sem enviar e-mail.`,
                    "Confirmação",
                    [{ id: "confirmar_cancelamento", texto: "Sim, Cancelar" }, { id: "cancelar_abortar", texto: "Não" }]
                );
            }

            const prontBase = String(alunoAtual.prontuario || "").toUpperCase();
            const prontCompleto = prontBase.startsWith("PT") ? prontBase : `PT${prontBase}`;
            const prontNumerico = apenasDigitos(prontBase);

            try {
                const imgBuffer = await gerarImagemEmailCancelamento({
                    nome: alunoAtual.nome || "Aluno",
                    prontuarioCompleto: prontCompleto,
                    prontuarioNumerico: prontNumerico,
                    diaSemana: NOMES_DIAS_SEMANA[dataAlvo.getDay()],
                    data: formatarDDMM(dataAlvo),
                });

                return [
                    { image: imgBuffer, caption: "📧 Este é o e-mail que será enviado ao CAE:" },
                    criarBotoes(`Deseja solicitar o cancelamento para *${dataStr}*?`, "Confirmação", [
                                { id: "confirmar_cancelamento", texto: "Sim, Enviar" },
                                { id: "cancelar_abortar", texto: "Não" }])
                ];
            } catch (erroImg) {
                logger.warn(`[PREVIEW] Falha ao gerar imagem: ${erroImg.message}`);
                return criarBotoes(
                    `Deseja enviar e-mail de cancelamento para *${dataStr}*?\n\n_Aluno: ${alunoAtual.nome} | ${prontCompleto}_`,
                    "Confirmação",
                    [{ id: "confirmar_cancelamento", texto: "Sim, Enviar" }, { id: "cancelar_abortar", texto: "Não" }]
                );
            }
        }

        // --- NOVO MENU DE CANCELAMENTO ---
        if (usuario.etapa === "MENU_CANCELAR_OPCOES") {
            if (["1", "cancelar_prox", "amanha", "amanhã"].includes(textoNorm) || textoNorm.includes("amanha")) {
               const proxDataStr = usuario.dados_temporarios?.proxData;
               const dataAlvo = proxDataStr ? new Date(proxDataStr) : obterProximoDiaPreferido(new Date(), await conectarBanco(c => obterDiasPreferidos(c, alunoAtual.id)));
               return await processarFluxoCancelamentoDia(dataAlvo);

            } else if (["2", "cancelar_outro", "outro"].includes(textoNorm) || textoNorm.includes("outro")) {
               atualizarUsuario(chaveUsuario, { etapa: "ESCOLHER_DIA_CANCELAMENTO", dados_temporarios: {} });
               
               let listaVisual = "";
               if (dadosSemana) {
                   const nomeDias = ["Seg", "Ter", "Qua", "Qui", "Sex"];
                   const agora = new Date();
                   let segunda = obterSegundaDaSemana(agora);
                   if (agora.getDay() === 0 || agora.getDay() === 6) segunda.setDate(segunda.getDate() + 7);
                   
                   for (let i = 0; i < 5; i++) {
                       const dataDodia = new Date(segunda);
                       dataDodia.setDate(segunda.getDate() + i);
                       const diaIso = dataIsoUTC(dataDodia);
                       const pedido = dadosSemana.pedidos.find(p => dataIsoUTC(p.dia_pedido) === diaIso);
                       const statusIcon = pedido ? (classificarMotivo(pedido.motivo).tipo === "PEDIU_OK" ? "✅" : (classificarMotivo(pedido.motivo).tipo === "NAO_PEDIU" || pedido.motivo.includes("CANCELADO") ? "❌" : "⚠️")) : (dadosSemana.diasPreferidos.includes(i + 1) ? "📅" : "❌");
                       listaVisual += `\n${statusIcon} ${nomeDias[i]} ${formatarDataBR(dataDodia)}`;
                   }
               }
               
               return criarTexto(`Qual dia da semana você quer cancelar?\n${listaVisual}\n\nEscreva o dia (ex: *quarta* ou *amanhã*).`);
            }
        }

        if (usuario.etapa === "ESCOLHER_DIA_CANCELAMENTO") {
            if (textoNorm.includes("amanha") || textoNorm.includes("amanhã") || textoNorm.includes("hoje")) {
               // Deixa o fluxo principal pegar isso embaixo
               atualizarUsuario(chaveUsuario, { etapa: "MENU_PRINCIPAL" });
               return await processarTexto(jid, "cancelar " + textoNorm, false, true);
            }
            const numeroDiaAlvo = obterNumeroDia(textoNorm);
            if (!numeroDiaAlvo) return criarTexto("Não entendi o dia. Digite algo como 'quarta' ou 'segunda'.");
            const dataAlvo = obterProximaDataParaDiaSemana(numeroDiaAlvo);
            return await processarFluxoCancelamentoDia(dataAlvo);
        }

        if (textoNorm.startsWith("cancelar") || (textoNorm.includes("nao vou") && textoNorm !== 'nao')) {
            const partes = textoNorm.split(/\s+/).map(normalizar).filter(Boolean);
            
            // Abriu o menu base "cancelar"
            if (partes.length === 1 && textoNorm === "cancelar") {
                 const diasPreferidos = await conectarBanco(c => obterDiasPreferidos(c, alunoAtual.id));
                 const proxData = obterProximoDiaPreferido(new Date(), diasPreferidos, usuario.ultimaDataCancelamento);
                 const strProxData = `${NOMES_DIAS_CURTO[proxData.getDay()]} ${formatarDDMM(proxData)}`;
                 
                 atualizarUsuario(chaveUsuario, { etapa: "MENU_CANCELAR_OPCOES", dados_temporarios: { proxData: proxData.toISOString() }});
                 return criarBotoes(
                     `Qual almoço você quer cancelar?`,
                     "Escolha",
                     [
                       { id: "cancelar_prox", texto: `Amanhã/Próx (${strProxData})` },
                       { id: "cancelar_outro", texto: "Escolher outro dia" }
                     ]
                 );
            }

            // Ex: "cancelar quarta", "cancelar amanha"
            let dataAlvo = null;
            if (textoNorm.includes("amanha") || textoNorm.includes("amanhã")) {
                const diasPreferidos = await conectarBanco(c => obterDiasPreferidos(c, alunoAtual.id));
                dataAlvo = obterProximoDiaPreferido(new Date(), diasPreferidos, usuario.ultimaDataCancelamento);
            } else if (textoNorm.includes("hoje")) {
                dataAlvo = new Date(); 
            } else {
                 const diaBusca = textoNorm.replace("cancelar ", "").replace("almoco ", "").replace("de ", "");
                 const numeroDiaAlvo = obterNumeroDia(diaBusca);
                 if (numeroDiaAlvo) dataAlvo = obterProximaDataParaDiaSemana(numeroDiaAlvo);
            }

            if (!dataAlvo) {
                 return criarTexto("Não entendi qual dia cancelar. Use 'cancelar quarta', 'cancelar amanhã' ou apenas 'cancelar' para ver o menu.");
            }
            return await processarFluxoCancelamentoDia(dataAlvo);
        }

        if (textoNorm.startsWith("preferencia") || textoNorm === "dias") {
            atualizarUsuario(chaveUsuario, { etapa: "DEFINIR_DIAS", dados_temporarios: {} });
            return menuDiasSemana("Selecione os dias da semana que você almoça:");
        }

        if (textoNorm.startsWith("bloquear") || textoNorm.includes("nao como")) {
            atualizarUsuario(chaveUsuario, { etapa: "DEFINIR_BLOQUEIOS", dados_temporarios: {} });
            return criarTexto("Envie os pratos para bloquear (separados por virgula). Ex: peixe, figado");
        }

        if (textoNorm.startsWith("desbloquear") || textoNorm === "limpar bloqueios") {
            const bloqueiosAtuais = await conectarBanco(c => obterBloqueios(c, alunoAtual.id));
            if (!bloqueiosAtuais.length) {
                atualizarUsuario(chaveUsuario, { etapa: "MENU_PRINCIPAL", dados_temporarios: {} });
                return criarTexto("Você não tem pratos bloqueados.");
            }
            atualizarUsuario(chaveUsuario, { etapa: "REMOVER_BLOQUEIOS", dados_temporarios: {} });
            return criarTexto(
                "*Pratos bloqueados atualmente:*\n" +
                bloqueiosAtuais.map(b => `- ${b}`).join("\n") +
                "\n\nEnvie os nomes para desbloquear (separados por vírgula)." +
                "\nOu envie *todos* para limpar tudo."
            );
        }

        // Ativar/Desativar
        // IMPORTANTE: "desativar" DEVE vir antes de "ativar"
        // porque "desativar" contém a palavra "ativar"
        if (textoNorm.includes("desativar") || textoNorm.includes("pausar")) {
            await conectarBanco(c => alterarStatusAtivo(c, alunoAtual.id, false));
            
            if (dadosSemana && dadosSemana.pedidos) {
                const hojeIso = dataIsoUTC(new Date());
                const diasParaCancelar = dadosSemana.pedidos.filter(p => {
                    const classificado = classificarMotivo(p.motivo);
                    return classificado.tipo === "PEDIU_OK" && dataIsoUTC(p.dia_pedido) >= hojeIso;
                });

                if (diasParaCancelar.length > 0) {
                    const strDias = diasParaCancelar.map(p => `✅ ${NOMES_DIAS_CURTO[new Date(p.dia_pedido).getDay()]} (${formatarDataBR(p.dia_pedido)})`).join("\n");
                    atualizarUsuario(chaveUsuario, { 
                        etapa: "CONFIRMAR_CANCELAMENTO_DESATIVAR", 
                        dados_temporarios: { dias: diasParaCancelar.map(p => p.dia_pedido.toISOString()) } 
                    });
                    return criarBotoes(
                        `Robô pausado. ✅\n\nNo entanto, você já tem pedidos feitos nesta semana:\n${strDias}\n\nQuer cancelar esses almoços já marcados?`,
                        "Cancelamento em Lote",
                        [
                            { id: "cancelar_todos", texto: "Sim, cancelar todos" },
                            { id: "nao_cancelar", texto: "Não, vou almoçar" }
                        ]
                    );
                }
            }

            atualizarUsuario(chaveUsuario, { etapa: "MENU_PRINCIPAL", dados_temporarios: {} });
            return criarTexto("Robô pausado. Ele não fará novos pedidos até que você o ative novamente.");
        }

        if (textoNorm.includes("ativar")) {
            await conectarBanco(c => alterarStatusAtivo(c, alunoAtual.id, true));
            atualizarUsuario(chaveUsuario, { etapa: "MENU_PRINCIPAL", dados_temporarios: {} });
            return criarTexto("Robô ativado. Ele voltará a pedir seus almoços.");
        }

        // Impede que a IA tente "adivinhar" comandos a partir de palavras soltas ou respostas casuais 
        // Exemplo: dizer "nao" não deve engatilhar o comando de cancelar almoco.
        if (!["CONFIRMAR_CANCELAMENTO", "CONFIRMAR_SUGESTOES_BLOQUEIO", "AGUARDANDO_PRONTUARIO", "AGUARDANDO_DIAS"].includes(usuario.etapa) &&
            ["nao", "não", "n", "sim", "s", "ok", "ta", "tá", "joia", "beleza", "blz", "valeu", "obrigado", "obrigada"].includes(textoNorm)) {
            return criarTexto("Certo! Se precisar de alguma coisa, é só enviar o número de um comando do menu principal. 😊");
        }

        // -- Fallback: tenta classificar com IA (so uma vez, evitar loop) --
        if (!jaUsouIA) {
            // Monta contexto do usuario para a IA
            const diasCadastrados = await conectarBanco(c => obterDiasPreferidos(c, alunoAtual.id));
            const bloqueiosUsuario = await conectarBanco(c => obterBloqueios(c, alunoAtual.id));
            const dadosParaIA = {
                nome: alunoAtual.nome || alunoAtual.prontuario,
                diasCadastrados,
                bloqueios: bloqueiosUsuario,
                ativo: alunoAtual.ativo,
                ultimoPedido: dadosSemana?.pedidos?.[0] ? `${dadosSemana.pedidos[0].dia_pedido} - ${dadosSemana.pedidos[0].motivo}` : null
            };

            const resultadoIA = await assistenteIA.classificarIntencao(texto, telefone, dadosParaIA);

            if (resultadoIA.tipo === "comando" && resultadoIA.valor !== "ajuda" && resultadoIA.valor !== "continuar") {
                return processarTexto(jid, resultadoIA.valor, false, true);
            }

            if (resultadoIA.tipo === "resposta" && resultadoIA.valor) {
                return criarTexto(resultadoIA.valor);
            }
        }

        // Se a IA nao conseguiu ou retornou "ajuda", mostra o menu
        return menuPrincipalInterativo(alunoAtual, pratoAtual, dadosSemana);
    }

    async function fecharBanco() {
        try { await pool.end(); } catch { }
    }

    return { processarTexto, fechar: fecharBanco };
}
