// assistente_ia.js
// Assistente IA usando Gemini 2.5 Flash Lite.
// Classifica intencoes E responde duvidas com contexto do usuario.
// Usado SOMENTE como fallback quando nenhum comando padrao bate.

import { GoogleGenerativeAI } from "@google/generative-ai";

// --- Constantes ---
const LIMITE_POR_USUARIO = 5;   // chamadas IA por usuario por dia
const LIMITE_GLOBAL_DIARIO = 15; // chamadas IA total por dia (RPD = 20, reserva 5)
const NOME_MODELO = "gemini-2.5-flash-lite";

const COMANDOS_VALIDOS = [
    "cancelar", "status", "historico",
    "preferencia", "bloquear", "desbloquear",
    "ativar", "desativar", "ajuda"
];

const PROMPT_SISTEMA = `Voce e o assistente do bot de almoço do IFSP.

COMO O SISTEMA FUNCIONA:
- O bot pede almoço AUTOMATICAMENTE de manha nos dias que o aluno escolheu
- Se o aluno NAO quer comer, precisa CANCELAR antes
- Pratos bloqueados sao pulados automaticamente
- O aluno pode configurar dias, bloquear pratos, ver status e historico

FORMATO DA SUA RESPOSTA:
- Se o usuario quer EXECUTAR uma acao, responda: COMANDO:nome
  Comandos: cancelar, status, historico, preferencia, bloquear, desbloquear, ativar, desativar
- Se o usuario faz uma PERGUNTA ou tem DUVIDA, responda em texto curto (1-2 frases) usando os dados do usuario
- NUNCA responda COMANDO:ajuda para perguntas sobre o sistema. So use COMANDO:ajuda se a mensagem nao tem relacao com almoço

EXEMPLOS:
Usuario (cadastrado seg,qua,sex): "amanha vai pedir pra mim?"
Se amanha e segunda: "Sim, amanha e segunda e voce esta cadastrado. O almoço sera pedido automaticamente de manha."
Se amanha e sabado: "Nao, amanha e sabado e voce so esta cadastrado para seg, qua e sex."

Usuario: "nao vou comer amanha"
Resposta: COMANDO:cancelar

Usuario: "como funciona esse bot?"
Resposta: "O bot pede seu almoço automaticamente nos dias que voce cadastrou (antes das 8h). Se nao quiser comer algum dia, e so cancelar."

Usuario: "quero ver meus dados"
Resposta: COMANDO:status

Usuario: "o que acontece se tiver peixe?"
Se peixe esta bloqueado: "Peixe esta na sua lista de bloqueios, entao o bot nao vai pedir almoço quando o prato do dia for peixe."
Se nao esta bloqueado: "O bot vai pedir normalmente. Se nao gosta de peixe, use o comando 'bloquear' para adicionar."

Usuario: "oi tudo bem?"
Resposta: COMANDO:ajuda

REGRAS:
- Maximo 2 frases
- Sem emoji
- Use os dados do contexto do usuario
- Seja direto e util`;

// --- Controle de Uso ---
let contadorGlobal = { quantidade: 0, data: "" };
const contadoresPorUsuario = new Map();

function obterDataHoje() {
    return new Date().toISOString().slice(0, 10);
}

function resetarSeNovoDia(contador) {
    const hoje = obterDataHoje();
    if (contador.data !== hoje) {
        contador.quantidade = 0;
        contador.data = hoje;
    }
}

function verificarLimiteUsuario(telefone) {
    const hoje = obterDataHoje();

    resetarSeNovoDia(contadorGlobal);
    if (contadorGlobal.quantidade >= LIMITE_GLOBAL_DIARIO) return false;

    if (!contadoresPorUsuario.has(telefone)) {
        contadoresPorUsuario.set(telefone, { quantidade: 0, data: hoje });
    }
    const contadorUsuario = contadoresPorUsuario.get(telefone);
    resetarSeNovoDia(contadorUsuario);

    return contadorUsuario.quantidade < LIMITE_POR_USUARIO;
}

function registrarUso(telefone) {
    resetarSeNovoDia(contadorGlobal);
    contadorGlobal.quantidade++;

    const contadorUsuario = contadoresPorUsuario.get(telefone);
    if (contadorUsuario) contadorUsuario.quantidade++;
}

// --- Cache Simples ---
const cacheClassificacoes = new Map();
const TAMANHO_MAX_CACHE = 50;

function normalizarParaCache(texto) {
    return texto.toLowerCase().trim().replace(/\s+/g, " ");
}

// O cache so funciona para comandos, nao para respostas contextuais
function buscarNoCache(texto) {
    const chave = normalizarParaCache(texto);
    const resultado = cacheClassificacoes.get(chave);
    if (resultado && resultado.tipo === "comando") return resultado;
    return null;
}

function salvarNoCache(texto, tipo, valor) {
    const chave = normalizarParaCache(texto);
    if (cacheClassificacoes.size >= TAMANHO_MAX_CACHE) {
        const primeiraChave = cacheClassificacoes.keys().next().value;
        cacheClassificacoes.delete(primeiraChave);
    }
    cacheClassificacoes.set(chave, { tipo, valor });
}

// --- Gera contexto do usuario para o prompt ---
const NOMES_DIAS = { 1: "seg", 2: "ter", 3: "qua", 4: "qui", 5: "sex" };

function gerarContextoUsuario(dadosUsuario) {
    if (!dadosUsuario) return "Usuario nao cadastrado.";

    const partes = [];
    partes.push(`Nome: ${dadosUsuario.nome || "desconhecido"} `);

    if (dadosUsuario.diasCadastrados && dadosUsuario.diasCadastrados.length) {
        const nomesDias = dadosUsuario.diasCadastrados.map(d => NOMES_DIAS[d] || d).join(", ");
        partes.push(`Dias cadastrados: ${nomesDias} `);
    } else {
        partes.push("Dias cadastrados: nenhum definido");
    }

    if (dadosUsuario.bloqueios && dadosUsuario.bloqueios.length) {
        partes.push(`Pratos bloqueados: ${dadosUsuario.bloqueios.join(", ")} `);
    }

    if (dadosUsuario.ativo !== undefined) {
        partes.push(`Bot: ${dadosUsuario.ativo ? "ativo" : "pausado"} `);
    }

    if (dadosUsuario.ultimoPedido) {
        partes.push(`Ultimo pedido: ${dadosUsuario.ultimoPedido} `);
    }

    // Dia da semana atual
    const hoje = new Date();
    const diaSemana = hoje.getDay(); // 0=dom, 1=seg...
    const nomeDiaHoje = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"][diaSemana];
    partes.push(`Hoje: ${nomeDiaHoje} (${hoje.toLocaleDateString("pt-BR")})`);

    const amanha = new Date(hoje);
    amanha.setDate(amanha.getDate() + 1);
    const diaSemanaAmanha = amanha.getDay();
    const nomeDiaAmanha = ["dom", "seg", "ter", "qua", "qui", "sex", "sab"][diaSemanaAmanha];
    partes.push(`Amanha: ${nomeDiaAmanha} `);

    return partes.join("\n");
}

// --- Funcao Principal ---

/**
 * Cria o assistente IA.
 * @param {string} chaveApi - Chave da API do Gemini
 * @param {object} logger - Logger (console ou pino)
 * @returns {{ classificarIntencao: Function }}
 */
export function criarAssistenteIA(chaveApi, logger = console) {
    if (!chaveApi) {
        logger.warn("GEMINI_API_KEY nao definida. IA desabilitada.");
        return {
            classificarIntencao: async () => ({ tipo: "nada", valor: null })
        };
    }

    const clienteGemini = new GoogleGenerativeAI(chaveApi);
    const modelo = clienteGemini.getGenerativeModel({
        model: NOME_MODELO,
        generationConfig: {
            maxOutputTokens: 150,    // permitir respostas curtas (antes era 20)
            temperature: 0.2,        // determinismo alto
        },
        systemInstruction: PROMPT_SISTEMA,
    });

    /**
     * Classifica a intencao de uma mensagem ou responde duvida.
     * @param {string} mensagem - Texto do usuario
     * @param {string} telefone - Numero do usuario (para rate limit)
     * @param {object} dadosUsuario - Contexto do usuario (nome, dias, bloqueios, etc)
     * @returns {Promise<{tipo: "comando"|"resposta"|"nada", valor: string|null}>}
     */
    async function classificarIntencao(mensagem, telefone, dadosUsuario = null) {
        // 1. Verifica cache (so para comandos)
        const emCache = buscarNoCache(mensagem);
        if (emCache) {
            logger.info(`[IA] Cache hit: "${mensagem}" -> ${emCache.valor} `);
            return emCache;
        }

        // 2. Verifica limites
        if (!verificarLimiteUsuario(telefone)) {
            logger.info(`[IA] Limite atingido para ${telefone} ou global.`);
            return { tipo: "nada", valor: null };
        }

        // 3. Monta o prompt com contexto do usuario
        const contexto = gerarContextoUsuario(dadosUsuario);
        const promptCompleto = `CONTEXTO DO USUARIO: \n${contexto} \n\nMENSAGEM DO USUARIO: "${mensagem}"`;

        // 4. Chama a IA
        try {
            const resultado = await modelo.generateContent(promptCompleto);
            const resposta = resultado.response.text().trim();

            registrarUso(telefone);

            // Verifica se e um comando (formato: COMANDO:nome)
            if (resposta.toUpperCase().startsWith("COMANDO:")) {
                const comando = resposta.slice(8).trim().toLowerCase();
                if (COMANDOS_VALIDOS.includes(comando)) {
                    const retorno = { tipo: "comando", valor: comando };
                    salvarNoCache(mensagem, "comando", comando);
                    logger.info(`[IA] Comando: "${mensagem}" -> ${comando} `);
                    return retorno;
                }
            }

            // Se nao e comando, e uma resposta contextual
            // Limpa formatacao excessiva
            let textoLimpo = resposta
                .replace(/^COMANDO:\s*/i, "")
                .replace(/\*+/g, "")
                .trim();

            if (textoLimpo.length > 0 && textoLimpo.length < 500) {
                logger.info(`[IA] Resposta: "${mensagem}" -> "${textoLimpo.substring(0, 60)}..."`);
                return { tipo: "resposta", valor: textoLimpo };
            }

            // Resposta vazia ou muito longa
            logger.info(`[IA] Resposta invalida para "${mensagem}"`);
            return { tipo: "nada", valor: null };
        } catch (erro) {
            logger.error(`[IA] Erro ao classificar: ${erro.message || erro} `);
            return { tipo: "nada", valor: null };
        }
    }

    return { classificarIntencao };
}
