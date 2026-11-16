// 日期按 CSV 中的本地日历解释；用 UTC 运算避免夏令时造成天数偏移。
export const DAY = 86400000;
export const TIME = '测量时间';
export const BODY_TYPE = '身体类型';
export const DEFAULT_METRICS = ['体重（kg）', '脂肪率（%）'];

export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n' || c === '\r')) {
      row.push(field.trim()); field = '';
      if (c !== ',') {
        if (row.some(Boolean)) rows.push(row);
        row = [];
        if (c === '\r' && text[i + 1] === '\n') i++;
      }
    } else field += c;
  }
  if (quoted) throw new Error('CSV 引号未闭合');
  row.push(field.trim());
  if (row.some(Boolean)) rows.push(row);
  const headers = rows.shift();
  if (!headers?.includes(TIME) || !DEFAULT_METRICS.every(key => headers.includes(key))) {
    throw new Error('CSV 缺少测量时间、体重或脂肪率字段');
  }
  const records = rows.map((cells, index) => {
    if (cells.length !== headers.length) throw new Error(`CSV 第 ${index + 2} 行列数不一致`);
    const raw = Object.fromEntries(headers.map((key, i) => [key, cells[i]]));
    const parts = raw[TIME].match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/);
    if (!parts) throw new Error(`CSV 第 ${index + 2} 行时间格式不正确`);
    const [, year, month, day, hour, minute] = parts.map(Number);
    const time = Date.UTC(year, month - 1, day, hour, minute);
    const date = new Date(time);
    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day || hour > 23 || minute > 59) {
      throw new Error(`CSV 第 ${index + 2} 行日期无效`);
    }
    const values = {};
    for (const key of headers) {
      if (key === TIME || key === BODY_TYPE) continue;
      values[key] = raw[key] === '' ? null : Number(raw[key]);
      if (values[key] !== null && !Number.isFinite(values[key])) throw new Error(`CSV 第 ${index + 2} 行的 ${key} 不是数值`);
    }
    return { time, values, raw, count: 1, start: time, end: time, aggregated: false };
  }).sort((a, b) => a.time - b.time);
  if (!records.length) throw new Error('CSV 暂无测量记录');
  return { headers, records };
}

export function dayStart(time) { return Math.floor(time / DAY) * DAY; }
export function dateLabel(time, short = false) {
  const date = new Date(time);
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return short ? `${month}.${day}` : `${date.getUTCFullYear()}.${month}.${day}`;
}

// 先筛选日期，再分组；自定义 N 天始终以数据首日为锚点，拖动范围不移动分组边界。
export function aggregate(records, mode, days = 7, anchor = records[0]?.time) {
  if (mode === 'all') return records;
  if (mode === 'custom' && (!Number.isInteger(days) || days < 1 || days > 365)) throw new Error('N 天必须是 1–365 的整数');
  const groups = new Map();
  for (const record of records) {
    const date = new Date(record.time);
    let key;
    if (mode === 'month') key = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    else if (mode === 'week') key = dayStart(record.time) - ((date.getUTCDay() + 6) % 7) * DAY;
    else key = dayStart(anchor) + Math.floor((dayStart(record.time) - dayStart(anchor)) / (days * DAY)) * days * DAY;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups.values()].map(items => {
    const values = {};
    for (const key of Object.keys(items[0].values)) {
      const valid = items.map(item => item.values[key]).filter(value => value !== null);
      values[key] = valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
    }
    const counts = new Map();
    for (const item of items) {
      const type = item.raw[BODY_TYPE];
      if (type) counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    const bodyType = [...counts].sort((a, b) => b[1] - a[1]).map(([type, count]) => ({ type, count }));
    const modes = bodyType.filter(item => item.count === bodyType[0]?.count).map(item => item.type);
    return {
      time: items.reduce((sum, item) => sum + item.time, 0) / items.length,
      values, raw: { [BODY_TYPE]: modes.join(' / ') || '—' }, count: items.length,
      start: items[0].time, end: items.at(-1).time, aggregated: true,
    };
  });
}
export function metricInfo(key) {
  const match = key.match(/^(.*?)（(.*?)）$/);
  return { key, name: match ? match[1] : key, unit: match ? match[2] : '' };
}
