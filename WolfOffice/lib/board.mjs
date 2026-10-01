// lib/board.mjs — live numbers for the Grow floor's wall screens and notice board.
import { growGet } from './growdb.mjs';
const today = () => new Date().toLocaleDateString('en-CA');

export async function growTiles() {
  const d = today();
  const [knock, sales] = await Promise.all([
    growGet(`knocking?select=rep,doors,contacts,sold,hours&date=eq.${d}`),
    growGet(`bria_sales_daily?select=rep,deals,installs&sale_date=eq.${d}`),
  ]);
  const sum = (rows, k) => rows.reduce((s, r) => s + (Number(r[k]) || 0), 0);
  const reps = new Set(knock.map(r => r.rep)).size;
  const tiles = [
    { label: 'Reps knocking today', value: reps },
    { label: 'Doors', value: sum(knock, 'doors').toLocaleString() },
    { label: 'Contacts', value: sum(knock, 'contacts').toLocaleString() },
    { label: 'Sold (knocking)', value: sum(knock, 'sold') },
    { label: 'Deals (Bria)', value: sum(sales, 'deals') },
    { label: 'Installs today', value: sum(sales, 'installs') },
    { label: 'Hours', value: sum(knock, 'hours').toFixed(1) },
    { label: 'Top rep (sold)', value: (knock.sort((a, b) => (b.sold || 0) - (a.sold || 0))[0] || {}).rep || '–' },
  ];
  return { tiles };
}

// Grow is the only floor. Any other name gets the Grow board.
export async function boardFor(_floor) {
  return growTiles();
}
