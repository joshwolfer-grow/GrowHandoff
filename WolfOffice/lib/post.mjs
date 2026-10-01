export async function postRows(env, table, rows) {
  const res = await fetch(`${env.url}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: env.key,
      Authorization: `Bearer ${env.key}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(rows),
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    let body = await res.text();
    body = body.split(env.key).join('[redacted]');
    body = body.slice(0, 200);
    throw new Error(`${table} ${res.status}: ${body}`);
  }
}
