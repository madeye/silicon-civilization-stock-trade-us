import { NextRequest } from "next/server";
import { readUniverse } from "@/lib/universe";
import { proposeRefresh, applyRefresh } from "@/lib/universe-refresh";

export const runtime = "nodejs";
export const maxDuration = 180;

// NDJSON: progress / log / result / error
export async function POST(_req: NextRequest) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      };
      try {
        const current = readUniverse();
        send({ type: "log", message: `Current watchlist: ${current.entries.length} names — asking DeepSeek for changes…` });

        const proposal = await proposeRefresh(current);
        send({
          type: "log",
          message: `Proposal: +${proposal.adds.length} / -${proposal.removes.length} / reclassify ${proposal.reclassifies.length}`,
        });
        send({ type: "log", message: proposal.rationale });

        let validated = 0;
        const total = proposal.adds.filter(
          (a) => a.symbol && !current.entries.some((e) => e.symbol === a.symbol),
        ).length;
        send({ type: "progress", done: 0, total });

        const result = await applyRefresh(current, proposal, {
          onValidate: (symbol, ok) => {
            validated++;
            send({
              type: "log",
              message: `${ok ? "✓" : "✗"} validated ${symbol}`,
            });
            send({ type: "progress", done: validated, total });
          },
        });

        send({ type: "result", result });
        controller.close();
      } catch (e) {
        send({ type: "error", message: e instanceof Error ? e.message : String(e) });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Accel-Buffering": "no",
    },
  });
}
