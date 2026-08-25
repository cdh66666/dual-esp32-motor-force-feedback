const $ = (selector, root = document) => root.querySelector(selector);
const boards = new Map();
const focusedPort = (new URLSearchParams(location.search).get('focus') || '').toUpperCase();
let displayUnit = 'deg';

const COLORS = {
  position: '#31d5c8',
  target: '#ff6678',
  velocity: '#49a9ff',
  current: '#d68bff',
  pwm: '#4bdd92',
  bus: '#ffb64d'
};

const CHARTS = {
  multi: { title: '多圈位置', color: COLORS.position, smooth: 0.45 },
  velocity: { title: '速度', color: COLORS.velocity, smooth: 0.18 },
  current: { title: 'INA240 电机支路电流', color: COLORS.current, fixed: [-5, 5], smooth: 0.25 },
  pwm: { title: '有符号 PWM', color: COLORS.pwm, fixed: [-4095, 4095], smooth: 0.35 },
  bus: { title: '母线电压', color: COLORS.bus, fixed: [0, 15], smooth: 0.12 }
};

const PARAM_SLIDERS = new Set([
  'currentKp', 'currentKi', 'currentMaxPwm',
  'velocityKp', 'velocityKi', 'velocityMaxCurrent', 'velocityFriction',
  'positionKp', 'positionKi', 'positionKd', 'positionMaxVelocity',
  'positionMinVelocity', 'positionDeadband'
]);

const MOTION_SLIDERS = {
  positionTarget: 'position',
  velocityTarget: 'velocity',
  currentTarget: 'current'
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const fmt = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : '—';
const positionValue = value => displayUnit === 'rev' ? value / 360 : value;
const velocityValue = value => displayUnit === 'rev' ? value / 360 : value;
const positionUnit = () => displayUnit === 'rev' ? '圈' : '°';
const velocityUnit = () => displayUnit === 'rev' ? 'rps' : '°/s';

function toast(message, bad = false) {
  const element = document.createElement('div');
  element.className = 'toast' + (bad ? ' bad' : '');
  element.textContent = message;
  $('#toast').append(element);
  setTimeout(() => element.remove(), 3200);
}

async function api(path, body) {
  const options = body ? {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  } : {};
  const response = await fetch('/api/' + path, options);
  const result = await response.json();
  if (!response.ok || result.ok === false) throw new Error(result.error || response.statusText);
  return result;
}

async function send(port, command) {
  try {
    return await api('send', { port, command });
  } catch (error) {
    toast(port + ': ' + error.message, true);
    throw error;
  }
}

function initialBoard(port) {
  return {
    port,
    active: false,
    writeOk: false,
    hwid: '',
    seq: 0,
    polling: false,
    connecting: false,
    samples: [],
    latest: {},
    timers: {},
    configApplied: false,
    busAddress: null,
    lastUiAt: 0,
    lastDrawAt: 0,
    dirty: true,
    range: {
      multi: { min: -180, max: 180 },
      velocity: { min: -6000, max: 6000 }
    }
  };
}

function metric(label, key) {
  return '<div class="metric"><small>' + label + '</small><b data-metric="' + key + '">—</b></div>';
}

function slider(name, label, min, max, step, value) {
  return '<label class="slider-row"><span>' + label + '</span><output data-out="' + name + '"></output>' +
    '<input data-slider="' + name + '" type="range" min="' + min + '" max="' + max +
    '" step="' + step + '" value="' + value + '"></label>';
}

function chart(key, large = false) {
  return '<section class="chart' + (large ? ' large' : '') + '" data-chart="' + key + '">' +
    '<div class="chart-head"><span>' + CHARTS[key].title + '</span><b data-chart-value="' + key + '">—</b></div>' +
    '<canvas></canvas></section>';
}

function boardHtml(board) {
  return [
    '<article class="board" data-port="', board.port, '">',
    '<div class="board-head"><div><div class="board-name"><i class="dot"></i>', board.port,
    ' <span data-connected>未连接</span></div><div class="meta" data-hwid></div></div>',
    '<div class="board-actions"><button data-act="connect">连接</button><button data-act="zero">多圈清零</button>',
    '<button data-act="clear">清空图窗</button><button data-act="export">导出原始过程 CSV</button>',
    '<button data-act="stop" class="danger">STOP</button></div></div>',
    '<div class="loop-banner"><strong>三级串联</strong><span>电流环 2 kHz</span><i>→</i>',
    '<span>速度环 200 Hz</span><i>→</i><span>位置环 100 Hz</span>',
    '<em>USB 原始遥测 100 Hz · 图上细线=原始，粗线=平滑显示</em></div>',
    '<div class="status">',
    metric('多圈位置', 'multi'), metric('速度', 'velocity'), metric('母线', 'bus'),
    metric('实测电流', 'current'), metric('电流目标', 'currentTarget'),
    metric('PWM', 'pwm'), metric('nFAULT', 'fault'), metric('采样', 'rate'),
    '</div>',
    '<div class="content loop-stack">',
    '<div class="loop-block position-block">', chart('multi', true),
    '<section class="loop-controls"><h3>③ 位置环 · 100 Hz</h3>',
    slider('positionTarget', '目标多圈位置', -36000, 36000, 1, 0),
    '<div class="compact-sliders">',
    slider('positionKp', 'Kp（°/s / °）', 0, 12, 0.05, 3),
    slider('positionKi', 'Ki', 0, 2, 0.005, 0),
    slider('positionKd', 'Kd', 0, 5, 0.01, 0),
    slider('positionMaxVelocity', '最大速度 °/s', 100, 6000, 10, 1200),
    slider('positionMinVelocity', '脱困最小速度 °/s', 0, 600, 5, 150),
    slider('positionDeadband', '到位死区 °', 0.1, 10, 0.1, 2),
    '</div><div class="row"><button data-act="holdZero" class="primary">闭环保持 0°</button>',
    '<button data-act="positionTest">自动 360° 往返测试</button></div>',
    '<p class="hint">滑动目标即发送；目标范围 ±100 圈。位置环输出速度目标，不直接输出 PWM。</p></section></div>',
    '<div class="loop-grid">',
    '<div class="loop-block">', chart('velocity'),
    '<section class="loop-controls"><h3>② 速度环 · 200 Hz</h3>',
    slider('velocityTarget', '目标速度', -10000, 10000, 10, 0),
    '<div class="compact-sliders">',
    slider('velocityKp', 'Kp（A / (°/s)）', 0, 0.005, 0.00005, 0.0015),
    slider('velocityKi', 'Ki', 0, 0.005, 0.00005, 0.0005),
    slider('velocityMaxCurrent', '最大电流 A', 0.1, 4.5, 0.05, 3),
    slider('velocityFriction', '摩擦前馈 A', 0, 2, 0.01, 0.65),
    '</div><p class="hint">速度环输出电流目标；两块相同板使用同一组控制参数。</p></section></div>',
    '<div class="loop-block">', chart('current'),
    '<section class="loop-controls"><h3>① 电流环 · 2 kHz</h3>',
    slider('currentTarget', '目标电流', -4500, 4500, 10, 0),
    '<div class="compact-sliders">',
    slider('currentKp', 'Kp（PWM/A）', 0, 1500, 1, 150),
    slider('currentKi', 'Ki（PWM/(A·s)）', 0, 5000, 10, 1800),
    slider('currentMaxPwm', '电流环最大 PWM', 1, 4095, 1, 1500),
    '</div><p class="hint">这是电机支路/绕组电流，不等于电源平均输入电流。INA240A1 ×20、10 mΩ；SS6952T 板级内部限流约 5 A，软件最多 4.5 A。</p></section></div>',
    '</div>',
    '<div class="secondary-charts">', chart('pwm'), chart('bus'), '</div>',
    '<section class="utility"><div class="row"><strong>开环点动</strong>',
    slider('openPwm', 'PWM', 0, 4095, 1, 205),
    '<button data-act="ccw">反转 250 ms</button><button data-act="cw">正转 250 ms</button>',
    '<button data-act="applyAll">重新应用三环参数</button><button data-act="wake">唤醒驱动</button></div>',
    '<div class="row bus-row"><button data-act="businfo">总线状态</button>',
    '<button data-act="busPing">Ping 对端</button><button data-act="syncPosition">200 Hz 位置同步</button>',
    '<button data-act="syncStop">停止同步</button><span class="health" data-health>等待遥测</span></div></section>',
    '</div></article>'
  ].join('');
}

function ensureBoard(info) {
  let board = boards.get(info.port);
  if (!board) {
    board = initialBoard(info.port);
    boards.set(info.port, board);
    $('#boards').insertAdjacentHTML('beforeend', boardHtml(board));
    bindBoard(board);
  }
  const wasActive = board.active;
  board.active = Boolean(info.active);
  board.writeOk = Boolean(info.write_ok);
  board.hwid = info.hwid || info.description || '';
  if (!wasActive && board.active) {
    board.configApplied = false;
    board.seq = 0;
  }
  $('.dot', board.root).classList.toggle('on', board.active && board.writeOk);
  $('[data-connected]', board.root).textContent = !board.active ? '未连接' :
    board.writeOk ? '已连接' : '已枚举 · CDC 写端点异常';
  $('[data-hwid]', board.root).textContent = board.hwid + (info.last_error ? ' · ' + info.last_error : '');
  return board;
}

function setSlider(board, name, value) {
  const input = $('[data-slider="' + name + '"]', board.root);
  if (!input) return;
  input.value = value;
  updateSliderOutput(board, input);
}

function bindBoard(board) {
  board.root = document.querySelector('[data-port="' + board.port + '"]');
  board.canvases = {};
  board.root.querySelectorAll('[data-chart]').forEach(section => {
    board.canvases[section.dataset.chart] = $('canvas', section);
  });
  board.root.querySelectorAll('[data-slider]').forEach(input => {
    input.addEventListener('input', () => {
      const name = input.dataset.slider;
      updateSliderOutput(board, input);
      if (MOTION_SLIDERS[name]) scheduleMotion(board, MOTION_SLIDERS[name], Number(input.value));
      if (PARAM_SLIDERS.has(name)) {
        board.configApplied = false;
        scheduleConfig(board);
      }
    });
    updateSliderOutput(board, input);
  });
  board.root.addEventListener('click', event => {
    const button = event.target.closest('[data-act]');
    if (button) handleAction(board, button.dataset.act);
  });
}

function updateSliderOutput(board, input) {
  const output = $('[data-out="' + input.dataset.slider + '"]', board.root);
  if (output) output.textContent = sliderText(input.dataset.slider, Number(input.value));
}

function sliderText(name, value) {
  if (name === 'positionTarget') return fmt(positionValue(value), displayUnit === 'rev' ? 3 : 1) + ' ' + positionUnit();
  if (name === 'velocityTarget') return fmt(velocityValue(value), displayUnit === 'rev' ? 2 : 0) + ' ' + velocityUnit();
  if (name === 'currentTarget') return Math.round(value) + ' mA';
  if (name === 'openPwm' || name === 'currentMaxPwm') return Math.round(value) + ' / 4095 · ' + fmt(value / 40.95, 1) + '%';
  if (name === 'velocityMaxCurrent' || name === 'velocityFriction') return fmt(value, 2) + ' A';
  if (name === 'positionMaxVelocity' || name === 'positionMinVelocity') return Math.round(value) + ' °/s';
  if (name === 'positionDeadband') return fmt(value, 1) + '°';
  if (name === 'velocityKp' || name === 'velocityKi') return value.toFixed(5);
  return Number.isInteger(value) ? String(value) : String(value);
}

function valueOf(board, name) {
  return Number($('[data-slider="' + name + '"]', board.root).value);
}

function scheduleConfig(board) {
  clearTimeout(board.timers.config);
  board.timers.config = setTimeout(() => {
    if (board.active) applyCascade(board, false).catch(() => {});
  }, 180);
}

function scheduleMotion(board, mode, value) {
  clearTimeout(board.timers[mode]);
  board.timers[mode] = setTimeout(() => {
    if (board.active) runMotion(board, mode, value).catch(() => {});
  }, mode === 'position' ? 75 : 110);
}

async function applyCascade(board, notify = true) {
  if (!board.active) return;
  await send(board.port, 'cascade current ' + valueOf(board, 'currentKp') + ' ' +
    valueOf(board, 'currentKi') + ' ' + valueOf(board, 'currentMaxPwm'));
  await send(board.port, 'cascade velocity ' + valueOf(board, 'velocityKp') + ' ' +
    valueOf(board, 'velocityKi') + ' ' + valueOf(board, 'velocityMaxCurrent') + ' ' +
    valueOf(board, 'velocityFriction'));
  await send(board.port, 'cascade position ' + valueOf(board, 'positionKp') + ' ' +
    valueOf(board, 'positionKi') + ' ' + valueOf(board, 'positionKd') + ' ' +
    valueOf(board, 'positionMaxVelocity') + ' ' + valueOf(board, 'positionDeadband') + ' ' +
    valueOf(board, 'positionMinVelocity'));
  board.configApplied = true;
  if (notify) toast(board.port + ': 三环参数已应用');
}

async function ensureReady(board) {
  if (!board.configApplied) await applyCascade(board, false);
  if (!board.latest.awake) {
    await send(board.port, 'wake');
    await pause(35);
  }
}

async function runMotion(board, mode, value) {
  if (!board.active) return;
  await ensureReady(board);
  if (mode === 'position') await send(board.port, 'pos ' + value + ' 4095 30000');
  if (mode === 'velocity') await send(board.port, 'velocity ' + value + ' 4095 30000');
  if (mode === 'current') await send(board.port, 'current ' + value + ' 4095 30000');
}

async function runPositionTest(board) {
  clearTimeout(board.timers.positionTest);
  await send(board.port, 'stop');
  await ensureReady(board);
  await send(board.port, 'encreset');
  await pause(80);
  await runMotion(board, 'position', 360);
  board.timers.positionTest = setTimeout(() => {
    runMotion(board, 'position', 0).catch(() => {});
  }, 2600);
  toast(board.port + ': 360° 到位后自动回零');
}

function exportCsv(board) {
  if (!board.samples.length) {
    toast(board.port + ': 暂无过程数据', true);
    return;
  }
  const keys = [
    't_ms', 'single_deg', 'multi_deg', 'position_target_deg', 'position_error_deg',
    'velocity_deg_s', 'velocity_target_deg_s', 'current_measured_A', 'current_target_A',
    'bus_V', 'pwm_signed', 'pwm_abs', 'nFAULT', 'awake', 'control', 'settled'
  ];
  const rows = board.samples.map(sample => [
    sample.t, sample.single, sample.multi, sample.multiTarget,
    sample.multiTarget - sample.multi, sample.velocity, sample.velocityTarget,
    sample.current, sample.currentTarget, sample.bus, sample.pwm,
    sample.pwmMagnitude, sample.fault, sample.awake, sample.control, sample.settled
  ]);
  const csv = [keys.join(','), ...rows.map(row => row.join(','))].join('\r\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = board.port + '-cascade-process-' + new Date().toISOString().replace(/[:.]/g, '-') + '.csv';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function handleAction(board, action) {
  try {
    if (action === 'connect') await api('connect', { port: board.port });
    if (action === 'stop') {
      Object.values(board.timers).forEach(clearTimeout);
      await send(board.port, 'stop');
    }
    if (action === 'zero') await send(board.port, 'encreset');
    if (action === 'clear') {
      board.samples.length = 0;
      board.range.multi = { min: -180, max: 180 };
      board.range.velocity = { min: -6000, max: 6000 };
      board.dirty = true;
    }
    if (action === 'export') exportCsv(board);
    if (action === 'applyAll') await applyCascade(board);
    if (action === 'wake') await send(board.port, 'wake');
    if (action === 'holdZero') await runMotion(board, 'position', 0);
    if (action === 'positionTest') await runPositionTest(board);
    if (action === 'cw' || action === 'ccw') {
      await ensureReady(board);
      await send(board.port, action + ' ' + valueOf(board, 'openPwm') + ' 250');
    }
    if (action === 'businfo') await send(board.port, 'businfo');
    if (action === 'busPing') {
      const peer = [...boards.values()].find(item => item.port !== board.port && item.busAddress);
      if (!peer) throw new Error('尚未读到对端总线地址');
      await send(board.port, 'bus ' + peer.busAddress + ' ping');
    }
    if (action === 'syncPosition') {
      const peer = [...boards.values()].find(item => item.port !== board.port && item.busAddress);
      if (!peer) throw new Error('尚未读到对端总线地址');
      await send(board.port, 'sync position ' + peer.busAddress + ' 0 4095 30000');
    }
    if (action === 'syncStop') await send(board.port, 'sync stop');
  } catch (error) {
    toast(board.port + ': ' + error.message, true);
  }
}

function numeric(value, fallback = 0) {
  const result = Number(value);
  return Number.isFinite(result) ? result : fallback;
}

function parseLine(board, text) {
  if (text.startsWith('S,')) {
    const part = text.split(',');
    if (part.length < 14) return;
    const pwmMagnitude = numeric(part[6]);
    const phase = numeric(part[14]);
    const legacySigned = part.length > 15 ? numeric(part[15]) : (phase ? pwmMagnitude : -pwmMagnitude);
    const control = numeric(part[12]);
    const cascadePwm = part.length > 23 ? numeric(part[23], legacySigned) : legacySigned;
    const measuredCurrent = part.length > 22 ? numeric(part[22]) / 1000 : numeric(part[5]) / 1000;
    const sample = {
      t: numeric(part[1]),
      single: numeric(part[2]),
      multi: numeric(part[3]),
      bus: numeric(part[4]),
      current: measuredCurrent,
      pwm: cascadePwm,
      pwmMagnitude,
      fault: numeric(part[7]),
      awake: numeric(part[8]),
      step: numeric(part[9]),
      raw: numeric(part[10]),
      velocity: numeric(part[11]),
      control,
      multiTarget: control === 3 ? numeric(part[13]) : numeric(part[3]),
      phase,
      settled: part.length > 19 ? numeric(part[19]) : 0,
      velocityTarget: part.length > 20 ? numeric(part[20]) : 0,
      currentTarget: part.length > 21 ? numeric(part[21]) / 1000 : 0
    };
    if (board.samples.length && sample.t < board.samples[board.samples.length - 1].t) board.samples.length = 0;
    board.latest = sample;
    board.samples.push(sample);
    if (board.samples.length > 1200) board.samples.splice(0, board.samples.length - 1200);
    updateRanges(board, sample);
    board.dirty = true;
    return;
  }
  const address = text.match(/BUS addr=(\d+)/);
  if (address) board.busAddress = Number(address[1]);
  if (/^(DIAG|ERR|MODEL|CASCADE_CFG|BUS_|SYNC_)/.test(text)) {
    const health = $('[data-health]', board.root);
    health.textContent = text;
    health.className = 'health ' + (text.startsWith('ERR') ? 'bad' : 'good');
  }
}

function expandRange(range, values, minimumSpan, quantum) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return;
  const low = Math.min(...finite);
  const high = Math.max(...finite);
  if (low >= range.min * 0.95 && high <= range.max * 0.95) return;
  const center = (low + high) / 2;
  const span = Math.max(minimumSpan, (high - low) * 1.35);
  range.min = Math.floor((center - span / 2) / quantum) * quantum;
  range.max = Math.ceil((center + span / 2) / quantum) * quantum;
}

function updateRanges(board, sample) {
  expandRange(board.range.multi, [sample.multi, sample.multiTarget], 360, 90);
  expandRange(board.range.velocity, [sample.velocity, sample.velocityTarget], 3600, 1000);
}

async function pollLogs(board) {
  if (!board.active || board.polling) return;
  board.polling = true;
  try {
    const result = await api('logs?port=' + encodeURIComponent(board.port) + '&since=' + board.seq);
    result.logs.forEach(entry => {
      board.seq = Math.max(board.seq, entry.seq);
      if (entry.direction === 'rx') parseLine(board, entry.text);
    });
  } catch (_) {
    board.active = false;
  } finally {
    board.polling = false;
  }
}

async function refreshPorts() {
  try {
    const result = await api('ports');
    const ports = result.ports.filter(port =>
      port.esp32 && (!focusedPort || port.port.toUpperCase() === focusedPort));
    ports.forEach(info => {
      const board = ensureBoard(info);
      if (!info.active && !board.connecting) {
        board.connecting = true;
        api('connect', { port: info.port }).catch(() => {}).finally(() => { board.connecting = false; });
      }
    });
    $('#portSummary').textContent = ports.length ?
      ports.map(port => port.port + (port.active ? ' 已连接' : ' 正在连接')).join(' · ') :
      '未发现 ESP32 USB 串口';
  } catch (error) {
    $('#portSummary').textContent = '端口检测失败：' + error.message;
  }
}

function telemetryRate(board) {
  const samples = board.samples.slice(-101);
  if (samples.length < 3) return NaN;
  const duration = samples[samples.length - 1].t - samples[0].t;
  return duration > 0 ? (samples.length - 1) * 1000 / duration : NaN;
}

function updateUi(board) {
  const sample = board.latest;
  if (!Number.isFinite(sample.t)) return;
  const set = (key, value) => {
    const element = $('[data-metric="' + key + '"]', board.root);
    if (element) element.textContent = value;
  };
  set('multi', fmt(positionValue(sample.multi), displayUnit === 'rev' ? 3 : 2) + ' ' + positionUnit());
  set('velocity', fmt(velocityValue(sample.velocity), displayUnit === 'rev' ? 2 : 0) + ' ' + velocityUnit());
  set('bus', fmt(sample.bus, 2) + ' V');
  set('current', fmt(sample.current, 3) + ' A');
  set('currentTarget', fmt(sample.currentTarget, 3) + ' A');
  set('pwm', fmt(sample.pwm, 0) + ' / 4095');
  set('fault', sample.fault ? '1 · 正常' : '0 · 故障');
  set('rate', fmt(telemetryRate(board), 1) + ' Hz');
  Object.keys(board.canvases).forEach(key => {
    const element = $('[data-chart-value="' + key + '"]', board.root);
    if (!element) return;
    if (key === 'multi') element.textContent = '实测 ' + fmt(positionValue(sample.multi), displayUnit === 'rev' ? 3 : 2) +
      ' / 目标 ' + fmt(positionValue(sample.multiTarget), displayUnit === 'rev' ? 3 : 2) + ' ' + positionUnit();
    if (key === 'velocity') element.textContent = '实测 ' + fmt(velocityValue(sample.velocity), displayUnit === 'rev' ? 2 : 0) +
      ' / 目标 ' + fmt(velocityValue(sample.velocityTarget), displayUnit === 'rev' ? 2 : 0) + ' ' + velocityUnit();
    if (key === 'current') element.textContent = '实测 ' + fmt(sample.current, 3) +
      ' / 目标 ' + fmt(sample.currentTarget, 3) + ' A';
    if (key === 'pwm') element.textContent = fmt(sample.pwm, 0) + ' / 4095';
    if (key === 'bus') element.textContent = fmt(sample.bus, 2) + ' V';
  });
}

function chartValue(sample, key) {
  if (key === 'multi') return positionValue(sample.multi);
  if (key === 'velocity') return velocityValue(sample.velocity);
  return sample[key];
}

function targetValue(sample, key) {
  if (key === 'multi') return positionValue(sample.multiTarget);
  if (key === 'velocity') return velocityValue(sample.velocityTarget);
  if (key === 'current') return sample.currentTarget;
  return NaN;
}

function axisRange(board, key) {
  if (CHARTS[key].fixed) return [...CHARTS[key].fixed];
  const range = board.range[key];
  let min = range.min;
  let max = range.max;
  if (displayUnit === 'rev' && (key === 'multi' || key === 'velocity')) {
    min /= 360;
    max /= 360;
  }
  return [min, max];
}

function nice(value) {
  const absolute = Math.abs(value);
  if (absolute >= 1000) return value.toFixed(0);
  if (absolute >= 10) return value.toFixed(1);
  return value.toFixed(2);
}

function drawChart(board, key, canvas) {
  const bounds = canvas.getBoundingClientRect();
  const dpr = Math.min(1.5, window.devicePixelRatio || 1);
  const width = Math.round(bounds.width * dpr);
  const height = Math.round(bounds.height * dpr);
  if (width < 40 || height < 40) return;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, width, height);
  const pad = { left: 62 * dpr, right: 14 * dpr, top: 14 * dpr, bottom: 27 * dpr };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const [min, max] = axisRange(board, key);
  const scaleY = value => pad.top + (max - clamp(value, min, max)) / (max - min) * plotHeight;

  context.strokeStyle = '#263b50';
  context.fillStyle = '#8fa8ba';
  context.font = (11 * dpr) + 'px system-ui';
  context.lineWidth = dpr;
  context.textAlign = 'right';
  for (let index = 0; index <= 4; index += 1) {
    const y = pad.top + plotHeight * index / 4;
    context.beginPath();
    context.moveTo(pad.left, y);
    context.lineTo(width - pad.right, y);
    context.stroke();
    context.fillText(nice(max - (max - min) * index / 4), pad.left - 7 * dpr, y + 4 * dpr);
  }
  context.textAlign = 'center';
  for (let index = 0; index <= 5; index += 1) {
    const x = pad.left + plotWidth * index / 5;
    context.beginPath();
    context.moveTo(x, pad.top);
    context.lineTo(x, pad.top + plotHeight);
    context.stroke();
    context.fillText((-10 + index * 2) + 's', x, height - 6 * dpr);
  }

  const samples = board.samples.slice(-1000);
  if (samples.length < 2) return;
  const offset = 1000 - samples.length;
  const scaleX = index => pad.left + (offset + index) / 999 * plotWidth;

  const stroke = (getter, color, lineWidth, alpha, smoothAlpha = 1) => {
    context.strokeStyle = color;
    context.lineWidth = lineWidth * dpr;
    context.globalAlpha = alpha;
    context.beginPath();
    let filtered = NaN;
    let began = false;
    samples.forEach((sample, index) => {
      const raw = getter(sample);
      if (!Number.isFinite(raw)) return;
      filtered = Number.isFinite(filtered) ? filtered + (raw - filtered) * smoothAlpha : raw;
      const x = scaleX(index);
      const y = scaleY(filtered);
      if (!began) {
        context.moveTo(x, y);
        began = true;
      } else {
        context.lineTo(x, y);
      }
    });
    if (began) context.stroke();
    context.globalAlpha = 1;
  };

  stroke(sample => chartValue(sample, key), CHARTS[key].color, 1, 0.24, 1);
  stroke(sample => chartValue(sample, key), CHARTS[key].color, 2.1, 1, CHARTS[key].smooth);
  if (key === 'multi' || key === 'velocity' || key === 'current') {
    context.setLineDash([6 * dpr, 5 * dpr]);
    stroke(sample => targetValue(sample, key), COLORS.target, 1.4, 0.95, 1);
    context.setLineDash([]);
  }
}

function animationFrame(now) {
  boards.forEach(board => {
    if (now - board.lastUiAt >= 100) {
      updateUi(board);
      board.lastUiAt = now;
    }
    if (board.dirty && now - board.lastDrawAt >= 33) {
      Object.entries(board.canvases).forEach(([key, canvas]) => drawChart(board, key, canvas));
      board.lastDrawAt = now;
      board.dirty = false;
    }
  });
  requestAnimationFrame(animationFrame);
}

$('#unit').addEventListener('change', event => {
  displayUnit = event.target.value;
  boards.forEach(board => {
    board.root.querySelectorAll('[data-slider]').forEach(input => updateSliderOutput(board, input));
    board.dirty = true;
  });
  const value = Number($('#fleetTarget').value);
  $('#fleetTargetOut').textContent = fmt(positionValue(value), displayUnit === 'rev' ? 3 : 0) + ' ' + positionUnit();
});

$('#fleetTarget').addEventListener('input', event => {
  const value = Number(event.target.value);
  $('#fleetTargetOut').textContent = fmt(positionValue(value), displayUnit === 'rev' ? 3 : 0) + ' ' + positionUnit();
});

$('#connectAll').addEventListener('click', () => {
  Promise.all([...boards.values()].map(board => api('connect', { port: board.port }))).catch(() => {});
});

$('#stopAll').addEventListener('click', () => {
  Promise.all([...boards.values()].filter(board => board.active).map(board => send(board.port, 'stop'))).catch(() => {});
});

$('#fleetSend').addEventListener('click', () => {
  const target = Number($('#fleetTarget').value);
  Promise.all([...boards.values()].filter(board => board.active).map(board => runMotion(board, 'position', target))).catch(() => {});
});

await refreshPorts();
setInterval(refreshPorts, 1000);
setInterval(() => boards.forEach(pollLogs), 40);
requestAnimationFrame(animationFrame);
