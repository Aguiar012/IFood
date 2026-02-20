import "dotenv/config";
import pkg from "pg";
const { Pool } = pkg;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function corrigirBanco() {
    console.log("🔌 Conectando ao banco de dados...");
    const client = await pool.connect();
    try {
        console.log("🛠️  Removendo restrição de 'apenas um telefone por aluno'...");

        // 1. Remove a restrição UNIQUE que impede múltiplos telefones (contato_aluno_id_key)
        await client.query(`ALTER TABLE contato DROP CONSTRAINT IF EXISTS contato_aluno_id_key;`);

        // 2. (Opcional) Adiciona uma restrição composta para não repetir o MESMO telefone para o MESMO aluno
        // Mas permite telefones diferentes para o mesmo aluno.
        try {
            await client.query(`ALTER TABLE contato ADD CONSTRAINT contato_aluno_telefone_key UNIQUE (aluno_id, telefone);`);
        } catch (e) {
            // Ignora se já existir
        }

        console.log("✅ Banco corrigido com sucesso! Agora suporta Multi-ID.");
    } catch (e) {
        console.error("❌ Erro ao corrigir banco:", e);
    } finally {
        client.release();
        await pool.end();
    }
}

corrigirBanco();
