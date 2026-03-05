// patch-baileys.js
// Corrige bug no Baileys 7.0.0-rc.9 onde encryptedStream() não espera
// o flush do arquivo criptografado antes de retornar, causando ENOENT
// no upload de mídia (imagens, vídeos, documentos).
//
// Patches:
// 1. Await 'finish' event no encFileWriteStream antes de retornar
// 2. Diagnostico: verifica se o arquivo existe apos flush (usa warn para ser visivel)
// 3. Listener de erro no writeStream

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const arquivo = path.join(
    __dirname,
    "..",
    "node_modules",
    "@whiskeysockets",
    "baileys",
    "lib",
    "Utils",
    "messages-media.js"
);

try {
    let conteudo = fs.readFileSync(arquivo, "utf-8");

    // Verifica se já tem o patch v3
    if (conteudo.includes("[BAILEYS-PATCH-V3]")) {
        console.log("[patch-baileys] v3 já aplicado, pulando.");
        process.exit(0);
    }

    // Remove patches anteriores: limpa qualquer await once + diagnóstico anterior
    // Restaura o original primeiro
    conteudo = conteudo.replace(
        /    encFileWriteStream\.on\('error'.*?\n/g,
        ""
    );
    conteudo = conteudo.replace(
        /        await once\(encFileWriteStream, 'finish'\);\n(?:.*BAILEYS-PATCH.*\n)*/g,
        ""
    );
    // Limpa bloco try/catch de diagnóstico se existir
    conteudo = conteudo.replace(
        /        \/\/ Diagnóstico:.*\n(?:        .*\n)*?        \}\n/g,
        ""
    );

    // ---- Patch: Adiciona listener de erro + await finish + stat check ----
    const antigoCreate = "const encFileWriteStream = createWriteStream(encFilePath);";
    const novoCreate =
        "const encFileWriteStream = createWriteStream(encFilePath);\n" +
        "    encFileWriteStream.on('error', (err) => { logger?.warn('[BAILEYS-PATCH-V3] WriteStream error: ' + err.message); });";

    if (conteudo.includes(antigoCreate) && !conteudo.includes("[BAILEYS-PATCH-V3]")) {
        conteudo = conteudo.replace(antigoCreate, novoCreate);
    }

    const antigoEnd = "encFileWriteStream.end();\n        originalFileStream?.end?.();";
    const novoEnd =
        "encFileWriteStream.end();\n" +
        "        await once(encFileWriteStream, 'finish');\n" +
        "        try { const _s = await fs.stat(encFilePath); logger?.warn('[BAILEYS-PATCH-V3] encFile OK: ' + encFilePath + ' size=' + _s.size); }\n" +
        "        catch (_e) { logger?.warn('[BAILEYS-PATCH-V3] encFile MISSING after finish: ' + encFilePath + ' err=' + _e.message); }\n" +
        "        originalFileStream?.end?.();";

    if (!conteudo.includes(antigoEnd)) {
        console.warn("[patch-baileys] Padrão .end() não encontrado — versão mudou? Pulando.");
        process.exit(0);
    }

    conteudo = conteudo.replace(antigoEnd, novoEnd);
    fs.writeFileSync(arquivo, conteudo, "utf-8");
    console.log("[patch-baileys] ✅ Patch v3 aplicado!");
} catch (erro) {
    console.error("[patch-baileys] Erro ao aplicar patch:", erro.message);
    process.exit(1);
}
