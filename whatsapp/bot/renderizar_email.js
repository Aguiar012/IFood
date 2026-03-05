// renderizar_email.js
// Renderiza o preview do email de cancelamento como imagem PNG.
// Usa satori (JSX -> SVG) + resvg (SVG -> PNG). Sem browser, ~5ms por imagem.

import satori from "satori";
import { Resvg } from "@resvg/resvg-js";
import fs from "fs";

// Carrega fonte uma vez (Arial ou fallback para qualquer .ttf disponível no sistema)
let fontData = null;

function carregarFonte() {
    if (fontData) return fontData;

    // Tenta fontes comuns em ordem de preferência
    const caminhos = [
        // Alpine Linux (Dockerfile: apk add ttf-liberation)
        "/usr/share/fonts/liberation/LiberationSans-Regular.ttf",
        // Debian/Ubuntu
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        // Windows
        "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/segoeui.ttf",
    ];

    for (const caminho of caminhos) {
        try {
            fontData = fs.readFileSync(caminho);
            return fontData;
        } catch { /* tenta o próximo */ }
    }

    throw new Error("Nenhuma fonte TTF encontrada no sistema");
}

let fontBoldData = null;

function carregarFonteBold() {
    if (fontBoldData) return fontBoldData;

    const caminhos = [
        // Alpine Linux (Dockerfile: apk add ttf-liberation)
        "/usr/share/fonts/liberation/LiberationSans-Bold.ttf",
        // Debian/Ubuntu
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        // Windows
        "C:/Windows/Fonts/arialbd.ttf",
        "C:/Windows/Fonts/seguisb.ttf",
    ];

    for (const caminho of caminhos) {
        try {
            fontBoldData = fs.readFileSync(caminho);
            return fontBoldData;
        } catch { /* tenta o próximo */ }
    }

    // Fallback: usa a fonte regular como bold
    return carregarFonte();
}

/**
 * Gera uma imagem PNG do preview do email de cancelamento.
 * @param {{ nome: string, prontuarioCompleto: string, prontuarioNumerico: string, diaSemana: string, data: string }} dados
 * @returns {Promise<Buffer>} Buffer do PNG
 */
export async function gerarImagemEmailCancelamento({ nome, prontuarioCompleto, prontuarioNumerico, diaSemana, data }) {
    const regular = carregarFonte();
    const bold = carregarFonteBold();

    // Layout JSX-like que replica o HTML do email real
    const elemento = {
        type: "div",
        props: {
            style: {
                display: "flex",
                flexDirection: "column",
                padding: "20px",
                backgroundColor: "#f5f5f5",
                width: "100%",
                height: "100%",
            },
            children: {
                type: "div",
                props: {
                    style: {
                        display: "flex",
                        flexDirection: "column",
                        backgroundColor: "#fff",
                        borderRadius: "8px",
                        overflow: "hidden",
                        boxShadow: "0 2px 8px rgba(0,0,0,0.1)",
                    },
                    children: [
                        // Header vermelho
                        {
                            type: "div",
                            props: {
                                style: {
                                    backgroundColor: "#d9534f",
                                    padding: "16px 20px",
                                    display: "flex",
                                },
                                children: {
                                    type: "div",
                                    props: {
                                        style: { color: "#fff", fontSize: "18px", fontWeight: "bold" },
                                        children: "Solicitação de Cancelamento de Almoço",
                                    },
                                },
                            },
                        },
                        // Corpo
                        {
                            type: "div",
                            props: {
                                style: {
                                    display: "flex",
                                    flexDirection: "column",
                                    padding: "20px",
                                },
                                children: [
                                    // Aluno
                                    {
                                        type: "div",
                                        props: {
                                            style: { display: "flex", fontSize: "15px", color: "#333", marginBottom: "10px" },
                                            children: [
                                                { type: "span", props: { style: { fontWeight: "bold" }, children: "Aluno: " } },
                                                { type: "span", props: { children: nome } },
                                            ],
                                        },
                                    },
                                    // Prontuário
                                    {
                                        type: "div",
                                        props: {
                                            style: { display: "flex", fontSize: "15px", color: "#333", marginBottom: "14px" },
                                            children: [
                                                { type: "span", props: { style: { fontWeight: "bold" }, children: "Prontuário: " } },
                                                { type: "span", props: { children: prontuarioCompleto } },
                                            ],
                                        },
                                    },
                                    // Caixa do prontuário numérico
                                    {
                                        type: "div",
                                        props: {
                                            style: {
                                                display: "flex",
                                                flexDirection: "column",
                                                alignItems: "center",
                                                backgroundColor: "#f8f9fa",
                                                border: "1px solid #ddd",
                                                borderRadius: "5px",
                                                padding: "15px",
                                                marginBottom: "14px",
                                            },
                                            children: [
                                                {
                                                    type: "div",
                                                    props: {
                                                        style: { fontSize: "13px", color: "#666", marginBottom: "8px" },
                                                        children: "Para copiar o prontuário:",
                                                    },
                                                },
                                                {
                                                    type: "div",
                                                    props: {
                                                        style: {
                                                            fontSize: "28px",
                                                            fontWeight: "bold",
                                                            letterSpacing: "3px",
                                                            backgroundColor: "#fff",
                                                            padding: "8px 16px",
                                                            border: "1px dashed #999",
                                                            borderRadius: "4px",
                                                        },
                                                        children: prontuarioNumerico,
                                                    },
                                                },
                                            ],
                                        },
                                    },
                                    // Data
                                    {
                                        type: "div",
                                        props: {
                                            style: { display: "flex", fontSize: "15px", color: "#333", marginBottom: "16px" },
                                            children: [
                                                { type: "span", props: { style: { fontWeight: "bold" }, children: "Data a cancelar: " } },
                                                { type: "span", props: { children: `${diaSemana}, ${data}` } },
                                            ],
                                        },
                                    },
                                    // Separador
                                    {
                                        type: "div",
                                        props: {
                                            style: {
                                                borderTop: "1px solid #eee",
                                                marginBottom: "12px",
                                            },
                                        },
                                    },
                                    // Rodapé
                                    {
                                        type: "div",
                                        props: {
                                            style: { fontSize: "11px", color: "#999" },
                                            children: "Mensagem automática",
                                        },
                                    },
                                ],
                            },
                        },
                    ],
                },
            },
        },
    };

    const svg = await satori(elemento, {
        width: 440,
        height: 380,
        fonts: [
            { name: "Arial", data: regular, weight: 400, style: "normal" },
            { name: "Arial", data: bold, weight: 700, style: "normal" },
        ],
    });

    const resvg = new Resvg(svg, { fitTo: { mode: "width", value: 880 } });
    const pngData = resvg.render();
    return Buffer.from(pngData.asPng());
}
