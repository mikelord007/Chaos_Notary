import Fastify from "fastify";
import pg from "pg";
import { Counter, Histogram, Registry } from "prom-client";

const { Pool } = pg;

// Read path talks ONLY to the replica. There is deliberately no fallback to
// the primary here — if the replica is down, /products returns 503. That
// gap is the resilience story this whole demo exists to expose.
const readPool = new Pool({
  host: process.env.PG_REPLICA_HOST ?? "pg-replica",
  port: Number(process.env.PG_REPLICA_PORT ?? 5432),
  user: process.env.PG_USER ?? "checkout",
  password: process.env.PG_PASSWORD ?? "chaos_dev_only_not_a_secret",
  database: process.env.PG_DATABASE ?? "checkout",
  max: 10,
  connectionTimeoutMillis: 2000,
  query_timeout: 2000,
});

const writePool = new Pool({
  host: process.env.PG_PRIMARY_HOST ?? "pg-primary",
  port: Number(process.env.PG_PRIMARY_PORT ?? 5432),
  user: process.env.PG_USER ?? "checkout",
  password: process.env.PG_PASSWORD ?? "chaos_dev_only_not_a_secret",
  database: process.env.PG_DATABASE ?? "checkout",
  max: 10,
  connectionTimeoutMillis: 2000,
  query_timeout: 2000,
});

const registry = new Registry();

const httpRequestsTotal = new Counter({
  name: "http_requests_total",
  help: "Total HTTP requests",
  labelNames: ["route", "status"] as const,
  registers: [registry],
});

const httpRequestDuration = new Histogram({
  name: "http_request_duration_seconds",
  help: "HTTP request duration in seconds",
  labelNames: ["route", "status"] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

const app = Fastify({ logger: true });

app.addHook("onResponse", async (request, reply) => {
  const route = request.routeOptions.url ?? "unmatched";
  const status = String(reply.statusCode);
  httpRequestsTotal.inc({ route, status });
  httpRequestDuration.observe(
    { route, status },
    reply.elapsedTime / 1000,
  );
});

app.get("/health", async () => {
  return { status: "ok" };
});

app.get("/metrics", async (_request, reply) => {
  reply.header("Content-Type", registry.contentType);
  return registry.metrics();
});

app.get("/products", async (_request, reply) => {
  try {
    const result = await readPool.query(
      "SELECT id, name, price_cents FROM products ORDER BY id",
    );
    return result.rows;
  } catch (err) {
    app.log.error({ err }, "read replica unavailable");
    reply.code(503);
    return { error: "replica unavailable" };
  }
});

interface CreateOrderBody {
  productId?: number;
  quantity?: number;
}

app.post<{ Body: CreateOrderBody }>("/orders", async (request, reply) => {
  const { productId, quantity } = request.body ?? {};
  if (!productId || !quantity || quantity < 1) {
    reply.code(400);
    return { error: "productId and quantity are required" };
  }
  try {
    const result = await writePool.query(
      "INSERT INTO orders (product_id, quantity) VALUES ($1, $2) RETURNING id",
      [productId, quantity],
    );
    reply.code(201);
    return { id: result.rows[0].id };
  } catch (err) {
    app.log.error({ err }, "primary unavailable");
    reply.code(503);
    return { error: "primary unavailable" };
  }
});

const port = Number(process.env.PORT ?? 3000);

app
  .listen({ host: "0.0.0.0", port })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
