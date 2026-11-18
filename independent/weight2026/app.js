import { parseCSV, aggregate, dateLabel, dayStart, metricInfo, DAY, TIME, BODY_TYPE, DEFAULT_METRICS } from './data.mjs';

const $ = id => document.getElementById(id);
const colors = ['#41765e', '#b07255'];
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const state = { records: [], headers: [], left: DEFAULT_METRICS[0], right: DEFAULT_METRICS[1], selected: [...DEFAULT_METRICS], mode: 'all', days: 7, start: 0, end: 0, span: 0, points: [], active: -1, pinned: false };
let plot = null, renderTimer, hideTimer, resizeTimer, summaryTimer, rangeUI = null;
// 触屏滑动查看时暂停淡入动画：每个数据点都重启 220 ms 动画会闪。
let scrubbing = false;
const detailFields = new Map();
const escapeHTML = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const number = value => value === null || value === undefined ? '—' : Number(value.toFixed(2)).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
const signed = value => `${value > 0 ? '+' : ''}${number(value)}`;
function fade(element) {
  if (!scrubbing && !reducedMotion.matches) {
    element.getAnimations().forEach(animation => animation.cancel());
    element.animate([{ opacity: .25 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
  }
}
function setText(id, value) {
  const element = $(id);
  if (element.textContent !== value) { element.textContent = value; fade(element); }
}
function initSummary() {
  const first = state.records[0], latest = state.records.at(-1);
  const [weight, fat] = DEFAULT_METRICS;
  const change = key => first.values[key] !== null && latest.values[key] !== null ? signed(latest.values[key] - first.values[key]) : '—';
  setText('record-span', `${dateLabel(first.time)} — ${dateLabel(latest.time)}`);
  const days = Math.round((dayStart(latest.time) - dayStart(first.time)) / DAY) + 1;
  $('record-count').innerHTML = `<span>${state.records.length} 次测量</span> · <span>${days} 天跨度</span>`;
  setText('weight-change', change(weight));
  // setText('fat-change', change(fat));
  setText('fat-dxa', 23.6);
}
// 概览固定一行三块：按可用宽度缩小数值的 strong 字号，日期放不下时换行，保证任何窗口下都完整并排显示。
function fitSummary() {
  const summary = document.querySelector('.summary');
  if (!summary || !summary.clientWidth) return;
  const dateLine = summary.querySelector('.summary-date'), dateEl = $('record-span');
  const valueLines = [...summary.querySelectorAll('.stat-value')];
  const valueEls = [...summary.querySelectorAll('.stat strong')];
  const sized = [dateEl, ...valueEls];
  for (const element of sized) element.style.removeProperty('font-size');
  const base = new Map(sized.map(element => [element, parseFloat(getComputedStyle(element).fontSize)]));
  // 只缩 strong，单位保持固定字号，避免缩到看不清。
  const apply = (elements, scale, floor) => {
    for (const element of elements) {
      element.style.fontSize = `${Math.max(base.get(element) * scale, floor)}px`;
    }
  };
  const overflows = line => line.scrollWidth > line.clientWidth + 1;
  // 二分查找刚好不溢出的最大比例。
  const fit = (line, elements, floor) => {
    let low = .3, high = 1;
    for (let step = 0; step < 12; step++) {
      const mid = (low + high) / 2;
      apply(elements, mid, floor);
      if (overflows(line)) high = mid; else low = mid;
    }
    return low;
  };
  // 两个数值共用一个比例，保证字号一致；它们都很短，缩到下限一定放得下。
  apply(valueEls, 1, 10);
  const scale = valueLines.some(overflows) ? Math.min(...valueLines.map(line => fit(line, valueEls, 10))) : 1;
  apply(valueEls, scale, 10);
  // 日期保持原字号：放不下一行时改在两行内断开，比缩成很小的字号更易读。
  dateLine.style.whiteSpace = 'nowrap';
  apply([dateEl], 1, 10);
  if (overflows(dateLine)) dateLine.style.whiteSpace = 'normal';
}
function initControls() {
  state.firstDay = dayStart(state.records[0].time);
  state.lastDay = dayStart(state.records.at(-1).time);
  state.span = Math.round((state.lastDay - state.firstDay) / DAY);
  state.start = 0; state.end = state.span;
  rangeUI = initRangeSlider();
  initAxisSelects();
  // 详情字段只创建一次，切换数据点时仅更新变化的值。
  $('detail-values').innerHTML = state.headers.filter(key => key !== TIME).map(key => `<div data-key="${escapeHTML(key)}"><dt>${escapeHTML(key)}</dt><dd></dd></div>`).join('');
  $('detail-values').querySelectorAll('[data-key]').forEach(element => detailFields.set(element.dataset.key, element));
  document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => {
    state.mode = button.dataset.mode;
    render();
  }));
  // 自定义天数：点击药丸、修改数字或按回车都会立刻切到自定义平均。
  $('custom-mode').addEventListener('click', () => applyCustom(true));
  $('custom-days').addEventListener('input', () => applyCustom());
  $('custom-days').addEventListener('change', () => applyCustom(true));
  $('custom-days').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); applyCustom(true); } });
  $('reset').addEventListener('click', resetView);
}
// 单条双头拖动条：两个手柄共用一条轨道，拖动中间的高亮带可整体平移区间。
function initRangeSlider() {
  const slider = $('range-slider');
  const fill = slider.querySelector('.range-fill');
  const handles = { start: $('range-start'), end: $('range-end') };
  const clamp = value => Math.max(0, Math.min(state.span, Math.round(value)));
  const radius = () => (handles.start.offsetWidth || 18) / 2;
  const usable = () => Math.max(slider.clientWidth - radius() * 2, 1);
  const xOf = value => state.span ? value / state.span * usable() : 0;
  const valueAt = clientX => clamp((clientX - slider.getBoundingClientRect().left - radius()) / usable() * state.span);
  let drag = null, moved = false;
  function layout() {
    const startX = xOf(state.start), endX = xOf(state.end), r = radius();
    handles.start.style.left = `${startX}px`;
    handles.end.style.left = `${endX}px`;
    fill.style.left = `${startX + r}px`;
    fill.style.width = `${Math.max(endX - startX, 0)}px`;
  }
  function moveHandle(name, value) {
    if (name === 'start') state.start = Math.min(clamp(value), state.end);
    else state.end = Math.max(clamp(value), state.start);
  }
  // 拖动时合并重绘，松手后立即渲染最终结果。
  function settle() {
    layout(); updateRangeLabels(); moved = true;
    clearTimeout(renderTimer);
    renderTimer = setTimeout(render, 50);
  }
  function finish() {
    if (!moved) return;
    moved = false;
    clearTimeout(renderTimer);
    render();
  }
  function onPointerdown(event) {
    if (event.button > 0 || !state.span) return;
    const value = valueAt(event.clientX);
    const handle = event.target.closest('[data-handle]');
    if (handle) {
      drag = { name: handle.dataset.handle, offset: value - state[handle.dataset.handle] };
      handle.focus({ preventScroll: true });
    } else if (event.target.closest('.range-fill')) {
      drag = { name: 'band', from: value, start: state.start, end: state.end };
    } else {
      const name = Math.abs(value - state.start) <= Math.abs(value - state.end) ? 'start' : 'end';
      drag = { name, offset: 0 };
      moveHandle(name, value);
      settle();
    }
    slider.setPointerCapture(event.pointerId);
    slider.classList.add('dragging');
    event.preventDefault();
  }
  function onPointermove(event) {
    if (!drag) return;
    const value = valueAt(event.clientX);
    if (drag.name === 'band') {
      const shift = Math.max(-drag.start, Math.min(state.span - drag.end, value - drag.from));
      if (!shift) return;
      state.start = drag.start + shift; state.end = drag.end + shift;
    } else {
      const before = state[drag.name];
      moveHandle(drag.name, value - drag.offset);
      if (state[drag.name] === before) return;
    }
    settle();
  }
  function endDrag(event) {
    if (!drag) return;
    drag = null;
    slider.classList.remove('dragging');
    if (slider.hasPointerCapture(event.pointerId)) slider.releasePointerCapture(event.pointerId);
    finish();
  }
  // 键盘：方向键移动 1 天，Shift+方向键 7 天，PageUp/PageDown 30 天。
  function onKeydown(event) {
    const name = event.currentTarget.dataset.handle, step = event.shiftKey ? 7 : 1;
    let delta;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') delta = -step;
    else if (event.key === 'ArrowRight' || event.key === 'ArrowUp') delta = step;
    else if (event.key === 'PageDown') delta = -30;
    else if (event.key === 'PageUp') delta = 30;
    else if (event.key === 'Home') delta = -state.span;
    else if (event.key === 'End') delta = state.span;
    else return;
    event.preventDefault();
    const before = state[name];
    moveHandle(name, state[name] + delta);
    if (state[name] === before) return;
    settle();
    finish();
  }
  for (const [name, handle] of Object.entries(handles)) {
    handle.setAttribute('aria-valuemax', String(state.span));
    handle.addEventListener('keydown', onKeydown);
    handle.dataset.handle = name;
  }
  slider.addEventListener('pointerdown', onPointerdown);
  slider.addEventListener('pointermove', onPointermove);
  slider.addEventListener('pointerup', endDrag);
  slider.addEventListener('pointercancel', endDrag);
  new ResizeObserver(() => layout()).observe(slider);
  return { layout };
}
function axisOptions() {
  return state.headers.filter(key => key !== TIME && key !== BODY_TYPE).map(key => {
    const info = metricInfo(key);
    return { key, label: info.unit ? `${info.name}（${info.unit}）` : info.name };
  });
}
function initAxisSelects() {
  const options = axisOptions();
  $('axis-left').innerHTML = options.map(item => `<option value="${escapeHTML(item.key)}">${escapeHTML(item.label)}</option>`).join('');
  syncAxisSelects();
  // 选择后立即更新图表，不再等待失去焦点。
  $('axis-left').addEventListener('change', () => {
    const next = $('axis-left').value;
    if (!next || next === state.left) return;
    // 左轴改用右轴正在显示的指标时两项互换，避免出现重复指标。
    if (next === state.right) state.right = state.left;
    state.left = next;
    syncAxisSelects();
    applyAxes();
  });
  $('axis-right').addEventListener('change', () => {
    const next = $('axis-right').value || null;
    if (next === state.left) return; // 右轴选项已排除左轴指标，此处仅作兜底。
    state.right = next;
    applyAxes();
  });
  setText('metric-hint', '选择后立即更新：第一项在左轴，第二项在右轴，可设为“无”只保留一条曲线。');
}
function syncAxisSelects() {
  const options = axisOptions();
  $('axis-left').value = state.left;
  const right = $('axis-right');
  right.innerHTML = '<option value="">无</option>' + options.filter(item => item.key !== state.left).map(item => `<option value="${escapeHTML(item.key)}">${escapeHTML(item.label)}</option>`).join('');
  right.value = state.right ?? '';
  if (right.value !== (state.right ?? '')) { state.right = null; right.value = ''; }
}
function applyAxes() {
  state.selected = state.right ? [state.left, state.right] : [state.left];
  const leftName = metricInfo(state.left).name;
  setText('metric-hint', state.right
    ? `已更新：${leftName} 使用左轴，${metricInfo(state.right).name} 使用右轴。`
    : `已更新：仅保留${leftName}，右轴收起。`);
  render();
}
function resetView() {
  clearTimeout(renderTimer);
  state.mode = 'all'; state.days = 7;
  state.left = DEFAULT_METRICS[0]; state.right = DEFAULT_METRICS[1];
  state.selected = [...DEFAULT_METRICS];
  state.start = 0; state.end = state.span;
  $('custom-days').value = '7';
  $('custom-days').setCustomValidity('');
  syncAxisSelects();
  rangeUI.layout();
  setText('metric-hint', '已重置为体重与脂肪率双轴，并显示全部日期。');
  render();
}
function applyCustom(report = false) {
  const value = Number($('custom-days').value);
  const valid = Number.isInteger(value) && value >= 1 && value <= 365;
  $('custom-days').setCustomValidity(valid ? '' : '请输入 1–365 之间的整数');
  if (!valid) {
    // 输入过程中只更新校验提示，提交时才弹出气泡，避免边打字边报错。
    if (report) $('custom-days').reportValidity();
    return;
  }
  if (state.mode === 'custom' && state.days === value) return;
  state.days = value;
  state.mode = 'custom';
  render();
}
function updateRangeLabels() {
  const start = state.firstDay + state.start * DAY, end = state.firstDay + state.end * DAY;
  setText('start-output', dateLabel(start));
  setText('end-output', dateLabel(end));
  setText('range-label', `${dateLabel(start, true)} — ${dateLabel(end, true)} · ${state.end - state.start + 1} 天`);
  for (const [name, time] of [['start', start], ['end', end]]) {
    const handle = $(`range-${name}`);
    handle.setAttribute('aria-valuenow', String(state[name]));
    handle.setAttribute('aria-valuetext', dateLabel(time));
  }
}
function render() {
  closeDetail(); updateRangeLabels();
  const start = state.firstDay + state.start * DAY, end = state.firstDay + (state.end + 1) * DAY;
  const filtered = state.records.filter(record => record.time >= start && record.time < end);
  state.points = aggregate(filtered, state.mode, state.days, state.records[0].time);
  document.querySelectorAll('[data-mode]').forEach(button => {
    const active = button.dataset.mode === state.mode;
    button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
  });
  $('custom-mode').classList.toggle('active', state.mode === 'custom');
  const note = { all: '每个圆点代表一次测量，保留原始记录。', week: '按自然周（周一至周日）取平均；仅计算所选范围内的记录。', month: '按自然月取平均；仅计算所选范围内的记录。', custom: `从数据首日开始，每 ${state.days} 天一组；仅计算所选范围内的记录。` };
  setText('group-note', note[state.mode]);
  const modeText = { all: '原始记录', week: '周平均', month: '月平均', custom: `${state.days} 天平均` }[state.mode];
  // setText('chart-description', `${filtered.length} 次测量 · ${state.points.length} 个数据点 · ${modeText}`);
  setText('chart-description', `${state.points.length} 个数据点 · ${modeText}`);
  const legendHTML = state.selected.map((key, i) => `<span class="legend-item"><span class="legend-line" style="--series:${colors[i]}"></span>${escapeHTML(metricInfo(key).name)} <span class="muted">${i ? '右轴' : '左轴'}</span></span>`).join('');
  if ($('legend').innerHTML !== legendHTML) { $('legend').innerHTML = legendHTML; fade($('legend')); }
  drawChart(); fade($('chart'));
}
function axisScale(values) {
  const min = Math.min(...values), max = Math.max(...values);
  const padding = Math.max((max - min) * .12, Math.abs(max) * .015, .5);
  const low = Math.max(0, min - padding), high = max + padding;
  return { low, high };
}
function drawChart() {
  const element = $('chart'), width = element.clientWidth, height = element.clientHeight;
  if (!state.points.length) {
    element.innerHTML = '<div class="empty-chart">这段时间没有测量记录<p>拖动下方的时间范围，选择其他日期。</p></div>';
    plot = null; return;
  }
  const mobile = width < 500;
  const left = mobile ? 42 : 54, right = state.selected.length === 2 ? (mobile ? 42 : 54) : 18;
  const top = 32, bottom = 30, w = width - left - right, h = height - top - bottom;
  const from = state.firstDay + state.start * DAY, to = state.firstDay + (state.end + 1) * DAY;
  const x = time => left + (time - from) / (to - from) * w;
  const scales = state.selected.map(key => {
    const values = state.points.map(point => point.values[key]).filter(value => value !== null);
    return values.length ? axisScale(values) : { low: 0, high: 1 };
  });
  const y = (value, axis) => top + (scales[axis].high - value) / (scales[axis].high - scales[axis].low) * h;
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="svg-title svg-description"><title id="svg-title">${escapeHTML(state.selected.map(key => metricInfo(key).name).join('与'))}随时间变化</title><desc id="svg-description">${state.points.length} 个数据点。${state.selected.length === 2 ? '左右纵轴分别缩放，请按各自刻度读取。' : ''}使用图表的左右方向键查看完整数值。</desc>`;
  for (let tick = 0; tick <= 4; tick++) {
    const py = top + tick * h / 4;
    svg += `<line class="grid-line" x1="${left}" y1="${py}" x2="${width - right}" y2="${py}"/>`;
    scales.forEach((scale, axis) => {
      const value = scale.high - tick * (scale.high - scale.low) / 4;
      svg += `<text x="${axis ? width - right + 10 : left - 10}" y="${py + 3}" text-anchor="${axis ? 'start' : 'end'}">${number(value)}</text>`;
    });
  }
  state.selected.forEach((key, axis) => {
    const metric = metricInfo(key);
    svg += `<text class="axis-title" x="${axis ? width - right : left}" y="13" text-anchor="${axis ? 'end' : 'start'}" style="fill:${colors[axis]}">${escapeHTML(metric.name + (metric.unit ? ` / ${metric.unit}` : ''))}</text>`;
  });
  const ticks = Math.min(mobile ? 4 : 7, state.end - state.start + 1);
  for (let i = 0; i < ticks; i++) {
    const time = ticks === 1 ? from : from + (to - from - DAY) * i / (ticks - 1);
    svg += `<text x="${x(time)}" y="${height - 7}" text-anchor="${i === 0 ? 'start' : i === ticks - 1 ? 'end' : 'middle'}">${dateLabel(time, true)}</text>`;
  }
  state.selected.forEach((key, axis) => {
    let path = '', connected = false;
    for (const point of state.points) {
      const value = point.values[key];
      if (value === null) { connected = false; continue; }
      path += `${connected ? 'L' : 'M'}${x(point.time).toFixed(2)},${y(value, axis).toFixed(2)} `;
      connected = true;
    }
    svg += `<path class="series-line" stroke="${colors[axis]}" d="${path}"/>`;
    for (const point of state.points) {
      if (point.values[key] === null) continue;
      svg += `<circle class="data-point" cx="${x(point.time)}" cy="${y(point.values[key], axis)}" r="${state.points.length > 90 ? 2 : 3}" stroke="${colors[axis]}"/>`;
    }
  });
  svg += '<g id="active-marker"></g></svg>';
  element.innerHTML = svg;
  plot = { x, y, left, right: width - right, top, bottom: height - bottom };
  element.setAttribute('aria-label', `${state.points.length} 个数据点的测量趋势图。使用左右方向键查看，Escape 关闭详情。`);
}
function pointAt(event) {
  if (!plot) return -1;
  const rect = $('chart').getBoundingClientRect(), px = event.clientX - rect.left, py = event.clientY - rect.top;
  // if (px < plot.left - 10 || px > plot.right + 10 || py < plot.top - 10 || py > plot.bottom + 10) return -1;
  if (px < plot.left - 0 || px > plot.right + 0 || py < plot.top - 0 || py > plot.bottom + 0) return -1;
  // 按屏幕距离选择圆点，触屏保留更大的命中范围。
  let best = -1, distance = event.pointerType === 'touch' ? 36 : 25;
  state.points.forEach((point, index) => state.selected.forEach((key, axis) => {
    if (point.values[key] === null) return;
    const d = Math.hypot(plot.x(point.time) - px, plot.y(point.values[key], axis) - py);
    if (d < distance) { distance = d; best = index; }
  }));
  return best;
}
// 触屏滑动时按横坐标找最近的数据点，手指不必正好落在圆点上。
function nearestIndex(event) {
  if (!plot || !state.points.length) return -1;
  const px = event.clientX - $('chart').getBoundingClientRect().left;
  let best = -1, distance = Infinity;
  state.points.forEach((point, index) => {
    const gap = Math.abs(plot.x(point.time) - px);
    if (gap < distance) { distance = gap; best = index; }
  });
  return best;
}
function showDetail(index) {
  clearTimeout(hideTimer); hideTimer = null;
  const point = state.points[index];
  if (!point || !plot) return;
  const changed = state.active !== index;
  state.active = index;
  if (changed) {
    setText('detail-kicker', point.aggregated ? '分组平均' : '测量详情');
    setText('detail-title', point.aggregated ? `${dateLabel(point.start)} — ${dateLabel(point.end, true)}` : point.raw[TIME].replaceAll('-', '.'));
    setText('detail-subtitle', point.aggregated ? `${point.count} 次测量 · 数值取平均，身体类型取众数（并列时全部列出）` : `第 ${state.records.indexOf(point) + 1} 次测量 · 加粗项为当前图表指标`);
    state.headers.filter(key => key !== TIME).forEach(key => {
      const value = key === BODY_TYPE ? point.raw[key] : point.aggregated ? number(point.values[key]) : point.raw[key] || '—';
      const field = detailFields.get(key);
      field.classList.toggle('selected', state.selected.includes(key));
      const output = field.querySelector('dd');
      if (output.textContent !== String(value)) { output.textContent = String(value); fade(output); }
    });
  }
  $('detail').classList.add('open'); $('detail').setAttribute('aria-hidden', 'false'); $('detail').inert = false;
  updateDetailFade();
  const px = plot.x(point.time);
  $('active-marker').innerHTML = `<line class="active-guide" x1="${px}" x2="${px}" y1="${plot.top}" y2="${plot.bottom}"/>` + state.selected.map((key, axis) => point.values[key] === null ? '' : `<circle class="point-ring" cx="${px}" cy="${plot.y(point.values[key], axis)}" r="4.5" stroke="${colors[axis]}"/>`).join('');
}
function closeDetail() {
  clearTimeout(hideTimer); hideTimer = null;
  if ($('detail').contains(document.activeElement)) $('chart').focus({ preventScroll: true });
  state.active = -1; state.pinned = false;
  $('detail').classList.remove('open'); $('detail').setAttribute('aria-hidden', 'true'); $('detail').inert = true;
  if ($('active-marker')) $('active-marker').innerHTML = '';
}
// 上下两端按滚动位置开关渐变遮罩：只有仍有内容被挡住的一侧才淡出。
function updateDetailFade() {
  const scroller = $('detail-scroll');
  const max = scroller.scrollHeight - scroller.clientHeight;
  scroller.classList.toggle('fade-top', scroller.scrollTop > 1);
  scroller.classList.toggle('fade-bottom', max > 1 && scroller.scrollTop < max - 1);
}
function initChartEvents() {
  $('detail-scroll').addEventListener('scroll', updateDetailFade, { passive: true });
  addEventListener('resize', () => {
    updateDetailFade();
    clearTimeout(summaryTimer);
    summaryTimer = setTimeout(fitSummary, 120);
  });
  // 触屏滑动查看：横向拖动超过阈值后接管手势，按横向位置逐点更新卡片。
  let scrub = null, suppressClick = false;
  const endScrub = event => {
    if (!scrub || (event && event.pointerId !== scrub.id)) return;
    if (scrub.moved) suppressClick = true;
    if (event && $('chart').hasPointerCapture(event.pointerId)) $('chart').releasePointerCapture(event.pointerId);
    scrub = null;
    scrubbing = false;
  };
  $('chart').addEventListener('pointerdown', event => {
    suppressClick = false;
    if (event.pointerType === 'mouse' || !event.isPrimary || !state.points.length) return;
    scrub = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false };
  });
  $('chart').addEventListener('pointermove', event => {
    if (event.pointerType === 'mouse') {
      if (state.pinned) return;
      const index = pointAt(event);
      if (index >= 0) showDetail(index);
      else if (!hideTimer) hideTimer = setTimeout(() => { hideTimer = null; closeDetail(); }, 150);
      return;
    }
    if (!scrub || scrub.id !== event.pointerId) return;
    if (!scrub.moved) {
      const dx = event.clientX - scrub.x, dy = event.clientY - scrub.y;
      // 主要横向移动才进入滑动查看，竖向手势留给页面滚动。
      if (Math.abs(dx) < 6 || Math.abs(dx) <= Math.abs(dy)) return;
      scrub.moved = true;
      scrubbing = true;
      state.pinned = true;
      $('chart').setPointerCapture(event.pointerId);
    }
    const index = nearestIndex(event);
    if (index >= 0) showDetail(index);
  });
  $('chart').addEventListener('pointerup', endScrub);
  $('chart').addEventListener('pointercancel', endScrub);
  $('chart').addEventListener('pointerleave', () => {
    if (!state.pinned) { clearTimeout(hideTimer); hideTimer = setTimeout(closeDetail, 220); }
  });
  $('chart').addEventListener('click', event => {
    if (suppressClick) { suppressClick = false; return; }
    const index = pointAt(event);
    if (index < 0) { closeDetail(); return; }
    if (state.pinned && state.active === index) closeDetail();
    else { state.pinned = true; showDetail(index); }
  });
  // 卡片弹出后，点击卡片以外的任何位置都会收起；点在数据点上则交给上面的点击逻辑切换到该点。
  document.addEventListener('pointerdown', event => {
    if (event.button > 0 || !$('detail').classList.contains('open')) return;
    if (event.target.closest('#detail')) return;
    if ($('chart').contains(event.target)) {
      // 触屏按在图表上可能是滑动查看的开始，先别收起；轻点空白仍由图表的 click 收起。
      if (event.pointerType !== 'mouse' || pointAt(event) >= 0) return;
    }
    closeDetail();
  });
  $('detail').addEventListener('pointerenter', () => { clearTimeout(hideTimer); hideTimer = null; });
  $('detail').addEventListener('pointerleave', () => { if (!state.pinned) closeDetail(); });
  $('close-detail').addEventListener('click', closeDetail);
  $('chart').addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !state.points.length) return;
    event.preventDefault();
    let index = state.active;
    if (event.key === 'Home') index = 0;
    else if (event.key === 'End') index = state.points.length - 1;
    else index = index < 0 ? 0 : Math.max(0, Math.min(state.points.length - 1, index + (event.key === 'ArrowRight' ? 1 : -1)));
    state.pinned = true; showDetail(index);
  });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeDetail(); });
  new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { closeDetail(); drawChart(); updateDetailFade(); }, 100);
  }).observe($('chart'));
}
async function init() {
  try {
    const response = await fetch('./raw_data.csv');
    if (!response.ok) throw new Error(`数据请求失败（${response.status}）`);
    const { headers, records } = parseCSV(await response.text());
    state.headers = headers; state.records = records;
    initSummary(); initControls();
    $('load-status').hidden = true; $('dashboard').hidden = false;
    rangeUI.layout(); fitSummary();
    render(); initChartEvents(); fade($('dashboard'));
  } catch (error) {
    $('load-status').textContent = `暂时无法显示记录：${error.message}。请确认 raw_data.csv 与页面位于同一目录，然后刷新重试。`;
    $('load-status').setAttribute('role', 'alert');
    $('load-status').hidden = false;
  }
}
init();
