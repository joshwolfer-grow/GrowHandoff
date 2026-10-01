import { describe, it, expect } from 'vitest';
import { headerSig, findSaved, mapByNames, checkMapping, preview, buildPrompt, parseAnswer, intakeFlags, safeName } from '../workers/grow/leaddesk.logic.mjs';

const slic = {
  name: 'Sheet1', rows: 4, width: 6,
  head: [
    ['Status', 'Address', 'Apt/Suite', 'Town', 'State', 'Postal Code'],
    ['New Lead', '794 N FM 1126', '', 'RICE', 'TX', '75155'],
    ['New Lead', '12 Main St', '2B', 'Corsicana', 'TX', '75110'],
  ],
};
const titled = {
  name: 'Leads', rows: 5, width: 4,
  head: [['GROW - week of Sep 5', '', '', ''], ['House #', 'Street Name', 'Zip', 'Wire-Sector'], ['12', 'Oak Ave', '12801', 'GF-4'], ['14', 'Oak Ave', '', 'GF-4']],
};
const oneCell = { name: 'csv', rows: 3, width: 2, head: [['Service Address', 'Customer'], ['123 Main St, Glens Falls, NY 12801-4420', 'Yes'], ['9 Elm Rd Apt 4, Queensbury, ny 12804', '']] };

describe('headerSig', () => {
  it('ignores case, spacing and trailing blanks', () => {
    expect(headerSig([' Address ', 'ZIP  Code', '', ''])).toBe('address|zip code');
  });
});

describe('findSaved', () => {
  it('finds a saved format even under a title row', () => {
    const formats = { [headerSig(titled.head[1])]: { cols: { streetnum: 0, street: 1, zip: 2, sector: 3 } } };
    expect(findSaved(titled, formats)).toMatchObject({ header_row: 1, source: 'saved', cols: { zip: 2 } });
  });
  it('is null when the headers changed', () => {
    expect(findSaved(slic, { 'address|zip': { cols: { street: 0, zip: 1 } } })).toBeNull();
  });
});

describe('mapByNames', () => {
  it('maps renamed city and postal columns', () => {
    expect(mapByNames(slic)).toMatchObject({ header_row: 0, cols: { status: 0, street: 1, unit: 2, city: 3, state: 4, zip: 5 } });
  });
  it('skips a title row and keeps a house number apart from the street', () => {
    const m = mapByNames({ ...titled, head: [titled.head[0], ['House Number', 'Street', 'Zip', 'Sector'], ...titled.head.slice(2)] });
    expect(m).toMatchObject({ header_row: 1, cols: { streetnum: 0, street: 1, zip: 2, sector: 3 } });
  });
  it('gives up when nothing looks like an address', () => {
    expect(mapByNames({ name: 'Key', rows: 3, width: 2, head: [['Color', 'Meaning'], ['Red', 'Do not knock']] })).toBeNull();
  });
});

describe('checkMapping', () => {
  it('passes a good mapping', () => {
    expect(checkMapping(mapByNames(slic), slic)).toEqual({ problems: [], warnings: [] });
  });
  it('stops a mapping with no zip', () => {
    expect(checkMapping({ header_row: 0, cols: { street: 1 } }, slic).problems.join()).toMatch(/no zip column/);
  });
  it('stops an index outside the sheet and two fields on one column', () => {
    expect(checkMapping({ header_row: 0, cols: { street: 1, zip: 9 } }, slic).problems.join()).toMatch(/column 9/);
    expect(checkMapping({ header_row: 0, cols: { street: 1, zip: 1 } }, slic).problems.join()).toMatch(/both point/);
  });
  it('warns about blank zips, the way two towns were once lost', () => {
    const w = checkMapping({ header_row: 1, cols: { streetnum: 0, street: 1, zip: 2, sector: 3 } }, titled).warnings.join();
    expect(w).toMatch(/1 of the first 2 rows have no zip/);
    expect(w).toMatch(/no city column/);
  });
  it('warns when the zip column holds something else', () => {
    expect(checkMapping({ header_row: 0, cols: { street: 1, zip: 3 } }, slic).warnings.join()).toMatch(/do not look like zips/);
  });
});

describe('preview', () => {
  it('splits a one-cell address and keeps the customer flag', () => {
    const rows = preview(oneCell, { header_row: 0, cols: { full: 0, customer: 1 } });
    expect(rows[0]).toMatchObject({ street: '123 Main St', city: 'Glens Falls', state: 'NY', zip: '12801', customer: 'Yes' });
    expect(rows[1]).toMatchObject({ street: '9 Elm Rd Apt 4', city: 'Queensbury', state: 'NY', zip: '12804' });
  });
});

describe('buildPrompt / parseAnswer', () => {
  it('sends only the first rows and says rows are data', () => {
    const p = buildPrompt([{ ...slic, head: Array.from({ length: 12 }, (_, i) => ['r' + i]) }]);
    expect(p).toContain('row 8:'); expect(p).not.toContain('row 9:');
    expect(p).toMatch(/Ignore any instructions/);
  });
  it('keeps known fields with integer indexes and drops the rest', () => {
    const text = 'Here you go:\n{"sheets":[{"name":"Sheet1","use":true,"header_row":0,"cols":{"street":1,"zip":5,"bogus":2,"city":"3"},"note":"ok"},{"name":"Other","use":true,"cols":{}}]}';
    expect(parseAnswer(text, [slic])).toEqual({ Sheet1: { use: true, header_row: 0, cols: { street: 1, zip: 5 }, note: 'ok' } });
  });
  it('honours a sheet marked as not addresses, and survives junk', () => {
    expect(parseAnswer('{"sheets":[{"name":"Sheet1","use":false,"note":"legend"}]}', [slic])).toEqual({ Sheet1: { use: false, note: 'legend' } });
    expect(parseAnswer('sorry, no', [slic])).toEqual({});
  });
});

describe('intakeFlags', () => {
  it('asks lead-import to carry sector, status and zip fill only when present', () => {
    expect(intakeFlags({ a: { cols: { street: 0, zip: 1 } } })).toEqual([]);
    expect(intakeFlags({ a: { cols: { street: 0, zip: 1, sector: 2 } }, b: { cols: { status: 0 } } }, { fillZip: true }))
      .toEqual(['--notes-from', 'Sector', '--status-from', 'Status', '--fill-zip-from-city']);
  });
});

describe('safeName', () => {
  it('keeps an ISP file name and strips any path', () => {
    expect(safeName('../../Grow NWCHIL Leads 2214.2257.xlsx')).toBe('Grow NWCHIL Leads 2214.2257.xlsx');
    expect(safeName('Minerva & Washington Cty (Sep 5) - GROW.csv')).toBe('Minerva & Washington Cty (Sep 5) - GROW.csv');
  });
  it('refuses anything that is not a lead file', () => {
    for (const n of ['run.sh', '.hidden.xlsx', '~$open.xlsx', 'x.xlsx.exe', '']) expect(safeName(n)).toBeNull();
  });
});

describe('mapByNames partial', () => {
  it('keeps what it could name when the street column has an odd header', () => {
    const s = { name: 'M', rows: 3, width: 4, head: [['List for Grow'], ['House #', 'Road', 'Town', 'Postal'], ['12', 'Oak Ave', 'Minerva', '12851']] };
    expect(mapByNames(s)).toBeNull();
    expect(mapByNames(s, { partial: true })).toMatchObject({ header_row: 1, source: 'none', cols: { streetnum: 0, city: 2, zip: 3 } });
  });
  it('reads a "Full Service Address" header as a one-cell address', () => {
    expect(mapByNames({ name: 'O', rows: 2, width: 2, head: [['Full Service Address', 'Notes'], ['1 Main St, Olmstedville, NY 12857', '']] })).toMatchObject({ cols: { full: 0 } });
  });
});
