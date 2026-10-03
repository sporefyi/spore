import type { DbClient } from "@spore/common";

export interface LogMeta {
  blockNumber: number;
  blockHash: string;
  txHash: string;
  logIndex: number;
  blockTime: Date;
}

export interface ParsedEvent {
  name: string;
  args: Record<string, any>;
}

function addr(a: unknown): string {
  return String(a).toLowerCase();
}

function num(v: unknown): string {
  return typeof v === "bigint" ? v.toString() : String(v);
}

function decodeKind(kind: unknown): string {
  const hex = String(kind).toLowerCase();
  if (hex.startsWith("0x7472")) return "treasury";
  if (hex.startsWith("0x6261")) return "backer-yield";
  return hex;
}

async function insertEventRow(
  db: DbClient,
  table: string,
  columns: string[],
  values: unknown[],
): Promise<boolean> {
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  const res = await db.query(
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}) ON CONFLICT (tx_hash, log_index) DO NOTHING`,
    values,
  );
  return res.rowCount !== 0;
}

export async function applyEvent(
  ev: ParsedEvent,
  meta: LogMeta,
  db: DbClient,
  chainId: number,
): Promise<void> {
  const a = ev.args;
  const common = [chainId, meta.blockNumber, meta.txHash.toLowerCase(), meta.logIndex, meta.blockTime];
  const commonCols = ["chain_id", "block_number", "tx_hash", "log_index", "block_time"];

  switch (ev.name) {
    case "AgentRegistered": {
      await db.query(
        `INSERT INTO agents (agent_id, owner, metadata_uri, active, registered_at, chain_id, block_number, tx_hash, log_index, block_time)
         VALUES ($1, $2, $3, true, $4, $5, $6, $7, $8, $4)
         ON CONFLICT (agent_id) DO UPDATE SET
           owner = EXCLUDED.owner,
           metadata_uri = EXCLUDED.metadata_uri,
           active = true,
           registered_at = EXCLUDED.registered_at,
           chain_id = EXCLUDED.chain_id,
           block_number = EXCLUDED.block_number,
           tx_hash = EXCLUDED.tx_hash,
           log_index = EXCLUDED.log_index,
           block_time = EXCLUDED.block_time`,
        [
          num(a.agentId),
          addr(a.owner),
          a.metadataURI,
          meta.blockTime,
          chainId,
          meta.blockNumber,
          meta.txHash.toLowerCase(),
          meta.logIndex,
        ],
      );
      return;
    }
    case "CreditIssued": {
      await db.query(
        `INSERT INTO credit_lines (agent_id, line_limit, fee_bps, drawn, fee_owed, active, defaulted, issued_at, updated_at)
         VALUES ($1, $2, $3, 0, 0, true, false, $4, now())
         ON CONFLICT (agent_id) DO UPDATE SET
           line_limit = EXCLUDED.line_limit,
           fee_bps = EXCLUDED.fee_bps,
           drawn = 0,
           fee_owed = 0,
           active = true,
           defaulted = false,
           issued_at = EXCLUDED.issued_at,
           updated_at = now()`,
        [num(a.agentId), num(a.limit), Number(a.feeBps), meta.blockTime],
      );
      return;
    }
    case "Borrow": {
      const ok = await insertEventRow(
        db,
        "borrows",
        ["agent_id", "amount", "fee", "merchant", ...commonCols],
        [num(a.agentId), num(a.amount), num(a.fee), "", ...common],
      );
      if (!ok) return;
      await db.query(
        `UPDATE credit_lines SET drawn = drawn + $2::numeric, fee_owed = fee_owed + $3::numeric WHERE agent_id = $1`,
        [num(a.agentId), num(a.amount), num(a.fee)],
      );
      return;
    }
    case "Payment": {
      const ok = await insertEventRow(
        db,
        "payments",
        ["agent_id", "merchant", "amount", ...commonCols],
        [num(a.agentId), addr(a.merchant), num(a.amount), ...common],
      );
      if (!ok) return;
      await db.query(
        `UPDATE borrows SET merchant = $1
         WHERE tx_hash = $2 AND log_index = (
           SELECT log_index FROM borrows
           WHERE tx_hash = $2 AND merchant = '' AND log_index < $3
           ORDER BY log_index DESC LIMIT 1
         )`,
        [addr(a.merchant), meta.txHash.toLowerCase(), meta.logIndex],
      );
      return;
    }
    case "Repay": {
      const ok = await insertEventRow(
        db,
        "repays",
        ["agent_id", "payer", "amount", "fee_portion", ...commonCols],
        [num(a.agentId), addr(a.payer), num(a.amount), num(a.feePortion), ...common],
      );
      if (!ok) return;
      await db.query(
        `UPDATE credit_lines SET
           fee_owed = GREATEST(0, fee_owed - $2::numeric),
           drawn = GREATEST(0, drawn - ($3::numeric - $2::numeric))
         WHERE agent_id = $1`,
        [num(a.agentId), num(a.feePortion), num(a.amount)],
      );
      return;
    }
    case "Default": {
      const ok = await insertEventRow(
        db,
        "defaults",
        ["agent_id", "drawn_amount", "covered_amount", "shortfall", ...commonCols],
        [num(a.agentId), num(a.drawnAmount), num(a.coveredAmount), num(a.shortfall), ...common],
      );
      if (!ok) return;
      await db.query(
        `UPDATE credit_lines SET drawn = 0, fee_owed = 0, active = false, defaulted = true WHERE agent_id = $1`,
        [num(a.agentId)],
      );
      return;
    }
    case "Sponsor": {
      await insertEventRow(
        db,
        "sponsors",
        ["agent_id", "backer", "amount", ...commonCols],
        [num(a.agentId), addr(a.backer), num(a.amount), ...common],
      );
      return;
    }
    case "Revenue": {
      await insertEventRow(
        db,
        "revenues",
        ["recipient", "amount", "kind", ...commonCols],
        [addr(a.recipient), num(a.amount), decodeKind(a.kind), ...common],
      );
      return;
    }
    case "CreditLimitChanged": {
      const ok = await insertEventRow(
        db,
        "credit_limit_changes",
        ["agent_id", "old_limit", "new_limit", ...commonCols],
        [num(a.agentId), num(a.oldLimit), num(a.newLimit), ...common],
      );
      if (!ok) return;
      await db.query(`UPDATE credit_lines SET line_limit = $2 WHERE agent_id = $1`, [
        num(a.agentId),
        num(a.newLimit),
      ]);
      return;
    }
    case "YieldAllocated": {
      await insertEventRow(
        db,
        "yield_allocations",
        ["agent_id", "amount", ...commonCols],
        [num(a.agentId), num(a.amount), ...common],
      );
      return;
    }
    default:
      throw new Error(`unknown event: ${ev.name}`);
  }
}
