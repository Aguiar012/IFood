// patch-baileys.js
// Corrige bug no Baileys 7.0.0-rc.9 onde encryptedStream() não espera
// o flush do arquivo criptografado antes de retornar, causando ENOENT
// no upload de mídia (imagens, vídeos, documentos).
//
// O fix: adiciona `await once(encFileWriteStream, 'finish')` após .end()

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

    const antigo = "encFileWriteStream.end();\n        originalFileStream?.end?.();";
    const novo =
        "encFileWriteStream.end();\n" +
        "        await once(encFileWriteStream, 'finish');\n" +
        "        originalFileStream?.end?.();";

    if (conteudo.includes("await once(encFileWriteStream, 'finish')")) {
        console.log("[patch-baileys] Já aplicado, pulando.");
        process.exit(0);
    }

    if (!conteudo.includes(antigo)) {
        console.warn("[patch-baileys] Padrão não encontrado — versão do Baileys mudou? Pulando.");
        process.exit(0);
    }

    conteudo = conteudo.replace(antigo, novo);
    fs.writeFileSync(arquivo, conteudo, "utf-8");
    console.log("[patch-baileys] ✅ Patch aplicado com sucesso!");
} catch (erro) {
    console.error("[patch-baileys] Erro ao aplicar patch:", erro.message);
    process.exit(1);
}
