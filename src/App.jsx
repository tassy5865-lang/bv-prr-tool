import React, { useState, useCallback, useRef, useMemo } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
  ScatterChart,
  Scatter,
  ZAxis,
} from "recharts";
import {
  UploadCloud,
  Download,
  Activity,
  FileWarning,
  X,
  ChevronRight,
  Droplet,
  TrendingDown,
  RotateCcw,
  GripVertical,
  Copy,
  Check,
  Printer,
} from "lucide-react";

// ---------- CSV / エンコーディング処理 ----------

function decodeBytes(buffer) {
  try {
    // fatal: true でないと不正なバイト列でも例外を投げず置換文字で黙って
    // デコードしてしまい、UTF-8へのフォールバックが機能しなくなる
    return new TextDecoder("shift_jis", { fatal: true }).decode(buffer);
  } catch (e) {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

function splitCsvLine(line) {
  return line.split(",");
}

function findColumnIndex(header, matchers) {
  for (const m of matchers) {
    const idx = header.findIndex((h) => h.trim() === m);
    if (idx !== -1) return idx;
  }
  for (const m of matchers) {
    const idx = header.findIndex((h) => h.includes(m));
    if (idx !== -1) return idx;
  }
  return -1;
}

// PRR(*100)の生データ配列から、抽出開始・終了インデックスを自動推定する
function autoDetectRange(prrVals) {
  const startIdx = 0;
  let endIdx = prrVals.length - 1;
  let cliffIdx = null;
  const CLIFF_DROP_THRESHOLD = 30; // これ以上の急落は治療終了・センサ外れとみなす

  for (let i = 1; i < prrVals.length; i++) {
    const prev = prrVals[i - 1];
    const cur = prrVals[i];
    if (prev >= 0 && cur < 0 && prev - cur > CLIFF_DROP_THRESHOLD) {
      cliffIdx = i - 1; // 最初の急落＝治療終了・センサ外れの瞬間を採用する
      break;
    }
  }
  if (cliffIdx !== null) endIdx = cliffIdx;
  return { startIdx, endIdx };
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0,
    dx2 = 0,
    dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }
  if (dx2 === 0 || dy2 === 0) return null;
  return num / Math.sqrt(dx2 * dy2);
}

function corrLabel(r) {
  if (r === null || r === undefined || Number.isNaN(r)) return "算出不可";
  const abs = Math.abs(r);
  let strength = "ほぼ無相関";
  if (abs >= 0.7) strength = "強い相関";
  else if (abs >= 0.4) strength = "中程度の相関";
  else if (abs >= 0.2) strength = "弱い相関";
  return `${r.toFixed(2)}(${strength})`;
}

// ファイル名 M1709234_20260701_085737.csv から短い表示名を作る
function shortLabelFromFilename(filename) {
  const m = filename.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (m) {
    const [, y, mo, d, h, mi] = m;
    return `${mo}/${d} ${h}:${mi}`;
  }
  return filename.replace(/\.csv$/i, "");
}

// ファイル名から実施日時(Dateオブジェクト)を抽出。取得できない場合はnull
function sessionTimestampFromFilename(filename) {
  const m = filename.match(/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, se] = m;
  const dt = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(se || 0));
  return Number.isNaN(dt.getTime()) ? null : dt.getTime();
}

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

// タイムスタンプ(ms)から「月」「火」のような曜日ラベルを返す。取得できない場合はnull
function weekdayLabelFromTimestamp(ts) {
  if (ts === null || ts === undefined) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return WEEKDAY_LABELS[d.getDay()];
}

// ファイル名の日時パターンより前の部分を患者(装置)IDとして抽出。取得できない場合はnull
// 例: M1709234_20260701_085737.csv -> "M1709234"
function patientIdFromFilename(filename) {
  const m = filename.match(/\d{4}\d{2}\d{2}_\d{2}\d{2}\d{2}/);
  if (!m) return null;
  const prefix = filename.slice(0, m.index).replace(/[_\-\s]+$/, "");
  return prefix || null;
}

// 透析装置(DCS-100NX)のCSVは、スプレッドシート上でAX列(50列目)に患者名が
// 記録されているため、その列から患者名を抽出する。列が存在しない場合はnull
const PATIENT_NAME_COLUMN_INDEX = 49; // AX列（0始まりで49）
function patientNameFromCsvRow(row) {
  if (!row || row.length <= PATIENT_NAME_COLUMN_INDEX) return null;
  const name = (row[PATIENT_NAME_COLUMN_INDEX] || "").trim();
  return name || null;
}

// ---------- CSVパース（列検出＋PRRによる自動区間のみ。行の絞り込みはderiveで行う） ----------

function parseCsvBase(text, filename) {
  const lines = text.split(/\r\n|\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) {
    throw new Error("データ行が見つかりませんでした");
  }
  const header = splitCsvLine(lines[0]);
  const sessionTimestamp = sessionTimestampFromFilename(filename);

  const prrIdx = findColumnIndex(header, ["PRR[L/h]*100", "PRR"]);
  if (prrIdx === -1) {
    throw new Error("PRR[L/h]*100 列が見つかりませんでした");
  }
  const dbvIdx = findColumnIndex(header, ["dBV[%]*10"]);
  const ufSpeedIdx = findColumnIndex(header, ["UFP-speed[L/h]*100"]);
  const ufVolumeIdx = findColumnIndex(header, ["UF-volume[L]*100"]);
  const sysBpIdx = findColumnIndex(header, ["sys-BP[mmHg]"]);
  const diaBpIdx = findColumnIndex(header, ["dia-BP[mmHg]"]);
  const hourIdx = findColumnIndex(header, ["hour"]);
  const minIdx = findColumnIndex(header, ["min"]);
  const secIdx = findColumnIndex(header, ["sec"]);
  const ttIdx = findColumnIndex(header, ["treat-time[sec]", "treat-time"]);

  const allRows = lines.slice(1).map((l) => splitCsvLine(l));

  const excludedCount = allRows.filter(
    (r) => r[prrIdx] !== undefined && r[prrIdx].trim() === "-9999"
  ).length;
  const filteredRows = allRows.filter(
    (r) => r[prrIdx] !== undefined && r[prrIdx].trim() !== "-9999" && r[prrIdx].trim() !== ""
  );
  if (filteredRows.length === 0) {
    throw new Error("-9999除外後に有効なデータがありませんでした");
  }

  const prrVals = filteredRows.map((r) => parseInt(r[prrIdx], 10));
  const autoRange = autoDetectRange(prrVals);

  const missingColumns = [];
  if (dbvIdx === -1) missingColumns.push("dBV[%]*10");
  if (ufSpeedIdx === -1 || ufVolumeIdx === -1) missingColumns.push("除水速度/除水量");
  if (sysBpIdx === -1 || diaBpIdx === -1) missingColumns.push("血圧");

  // CSVデータ本体(AX列)に患者名があればそれを優先し、なければファイル名から推定したIDにフォールバック
  const patientName = patientNameFromCsvRow(filteredRows[0] || allRows[0]);
  const patientIdFallback = patientIdFromFilename(filename);

  return {
    filename,
    shortLabel: shortLabelFromFilename(filename),
    sessionTimestamp,
    weekdayLabel: weekdayLabelFromTimestamp(sessionTimestamp),
    patientId: patientName || patientIdFallback,
    patientLabel: patientName || patientIdFallback || "患者ID不明",
    header,
    filteredRows,
    excludedCount,
    prrIdx,
    dbvIdx,
    ufSpeedIdx,
    ufVolumeIdx,
    sysBpIdx,
    diaBpIdx,
    hourIdx,
    minIdx,
    secIdx,
    ttIdx,
    autoRange,
    rangeStart: autoRange.startIdx,
    rangeEnd: autoRange.endIdx,
    missingColumns,
  };
}

// ---------- 選択された範囲から行データ・統計量を算出 ----------

function computeDerived(base) {
  const {
    filteredRows,
    prrIdx,
    dbvIdx,
    ufSpeedIdx,
    ufVolumeIdx,
    sysBpIdx,
    diaBpIdx,
    hourIdx,
    minIdx,
    secIdx,
    ttIdx,
    rangeStart,
    rangeEnd,
  } = base;

  const hasDbv = dbvIdx !== -1;
  const hasUf = ufSpeedIdx !== -1 && ufVolumeIdx !== -1;
  const hasBp = sysBpIdx !== -1 && diaBpIdx !== -1;

  const s = Math.max(0, Math.min(rangeStart, filteredRows.length - 2));
  const e = Math.max(s + 1, Math.min(rangeEnd, filteredRows.length - 1));

  const extracted = filteredRows.slice(s, e + 1);
  const firstTreatTimeSecRaw = ttIdx !== -1 ? parseInt(extracted[0][ttIdx], 10) : null;
  const firstTreatTimeSec = Number.isNaN(firstTreatTimeSecRaw) ? null : firstTreatTimeSecRaw;

  let prevSysBp = null;
  let prevDiaBp = null;

  const rows = extracted.map((r, i) => {
    const raw = parseInt(r[prrIdx], 10);
    const prrInstant = raw / 100; // PRR 瞬時値 [L/h]
    const prrIntervalVolumeL = prrInstant * (20 / 3600); // この20秒間にPRRが示す量 [L]
    const dbvPercent = hasDbv ? parseInt(r[dbvIdx], 10) / 10 : null;
    const ufSpeedLh = hasUf ? parseInt(r[ufSpeedIdx], 10) / 100 : null;
    const ufVolumeL = hasUf ? parseInt(r[ufVolumeIdx], 10) / 100 : null;
    const sysBp = hasBp ? parseInt(r[sysBpIdx], 10) : null;
    const diaBp = hasBp ? parseInt(r[diaBpIdx], 10) : null;
    const treatTimeSecRaw = ttIdx !== -1 ? parseInt(r[ttIdx], 10) : null;
    const treatTimeSec = Number.isNaN(treatTimeSecRaw) ? null : treatTimeSecRaw;
    const elapsedMin =
      treatTimeSec !== null && firstTreatTimeSec !== null
        ? Math.round(((treatTimeSec - firstTreatTimeSec) / 60) * 100) / 100
        : Math.round(((i * 20) / 60) * 100) / 100;

    const sysBpChanged = hasBp && (i === 0 || sysBp !== prevSysBp);
    const diaBpChanged = hasBp && (i === 0 || diaBp !== prevDiaBp);
    if (hasBp) {
      prevSysBp = sysBp;
      prevDiaBp = diaBp;
    }

    return {
      hour: hourIdx !== -1 ? r[hourIdx] : "",
      min: minIdx !== -1 ? r[minIdx] : "",
      sec: secIdx !== -1 ? r[secIdx] : "",
      treatTimeSec,
      treatTimeMin: treatTimeSec !== null ? Math.round((treatTimeSec / 60) * 10) / 10 : null,
      elapsedMin,
      raw,
      prrInstant,
      prrIntervalVolumeL,
      dbvPercent,
      ufSpeedLh,
      ufVolumeL,
      sysBp,
      diaBp,
      sysBpChanged,
      diaBpChanged,
    };
  });

  // ΔBVの50区間移動平均（末尾50点の単純移動平均、データが50点未満の区間はその時点までの平均）
  const MA_WINDOW = 50;
  if (hasDbv) {
    for (let i = 0; i < rows.length; i++) {
      const start = Math.max(0, i - MA_WINDOW + 1);
      let sum = 0;
      for (let j = start; j <= i; j++) sum += rows[j].dbvPercent;
      rows[i].dbvMA50 = sum / (i - start + 1);
    }
  }

  // ΔBV低下速度（移動平均を15サンプル≈5分前と比較した傾き, %/時間）。マイナスが大きいほど急激な血液濃縮＝脱水進行を示す
  // ウィンドウが揃うまで(直近5分に満たない先頭区間)はdtが極端に小さく計算が不安定になるため算出しない
  const RATE_WINDOW = 15;
  if (hasDbv) {
    for (let i = 0; i < rows.length; i++) {
      if (i < RATE_WINDOW) {
        rows[i].dbvRatePerHour = null;
        continue;
      }
      const j = i - RATE_WINDOW;
      const dt = rows[i].elapsedMin - rows[j].elapsedMin;
      rows[i].dbvRatePerHour = dt > 0 ? ((rows[i].dbvMA50 - rows[j].dbvMA50) / dt) * 60 : null;
    }
  }

  const first = rows[0];
  const last = rows[rows.length - 1];
  const totalPrrVolumeL = rows.reduce((sum, r) => sum + r.prrIntervalVolumeL, 0);

  let minDbvRow = hasDbv ? rows[0] : null;
  if (hasDbv) {
    rows.forEach((r) => {
      if (r.dbvPercent < minDbvRow.dbvPercent) minDbvRow = r;
    });
  }

  const corrDbvPrr = hasDbv
    ? pearson(
        rows.map((r) => r.dbvPercent),
        rows.map((r) => r.prrInstant)
      )
    : null;

  let minSysRow = null;
  if (hasBp) {
    minSysRow = rows[0];
    rows.forEach((r) => {
      if (r.sysBp < minSysRow.sysBp) minSysRow = r;
    });
  }
  const sysDrop = hasBp ? first.sysBp - minSysRow.sysBp : null;

  const corrDbvSys = hasBp && hasDbv
    ? pearson(
        rows.map((r) => r.dbvPercent),
        rows.map((r) => r.sysBp)
      )
    : null;

  const ufVolumes = hasUf ? rows.map((r) => r.ufVolumeL) : [];
  const totalUfVolumeL = hasUf ? Math.max(...ufVolumes) - Math.min(...ufVolumes) : null;

  const corrUfPrr = hasUf
    ? pearson(
        rows.map((r) => r.ufSpeedLh),
        rows.map((r) => r.prrInstant)
      )
    : null;

  return {
    rows,
    hasDbv,
    hasUf,
    hasBp,
    totalPrrVolumeL,
    minDbv: hasDbv ? minDbvRow.dbvPercent : null,
    minDbvTime: hasDbv
      ? `${minDbvRow.hour}:${String(minDbvRow.min).padStart(2, "0")}:${String(minDbvRow.sec).padStart(2, "0")}`
      : "-",
    corrDbvPrr,
    totalUfVolumeL,
    minSysBp: hasBp ? minSysRow.sysBp : null,
    minSysBpTime: hasBp
      ? `${minSysRow.hour}:${String(minSysRow.min).padStart(2, "0")}:${String(minSysRow.sec).padStart(2, "0")}`
      : "-",
    sysDrop,
    corrDbvSys,
    corrUfPrr,
    startLabel: `${first.hour}:${String(first.min).padStart(2, "0")}:${String(first.sec).padStart(2, "0")}`,
    endLabel: `${last.hour}:${String(last.min).padStart(2, "0")}:${String(last.sec).padStart(2, "0")}`,
    rangeS: s,
    rangeE: e,
    maxIdx: filteredRows.length - 1,
  };
}

// ---------- Excelダウンロード（SpreadsheetML、外部ライブラリ不使用） ----------

function escapeXml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function xmlCell(value) {
  if (value === null || value === undefined || value === "") return "<Cell/>";
  if (typeof value === "number" && Number.isFinite(value)) {
    return `<Cell><Data ss:Type="Number">${value}</Data></Cell>`;
  }
  return `<Cell><Data ss:Type="String">${escapeXml(value)}</Data></Cell>`;
}

function xmlRow(values) {
  return `<Row>${values.map(xmlCell).join("")}</Row>`;
}

function downloadExcel(filename, derived) {
  const header = [
    "hour",
    "min",
    "sec",
    "treat-time[sec]",
    "PRR[L/h]*100(raw)",
    "PRR_瞬時値[L/h]",
    "PRR_20秒区間量[L]",
    "dBV[%]",
    "除水速度[L/h]",
    "累積除水量[L]",
    "収縮期血圧[mmHg]",
    "拡張期血圧[mmHg]",
  ];
  const rowsXml = [xmlRow(header)];
  derived.rows.forEach((r) => {
    rowsXml.push(
      xmlRow([
        r.hour,
        r.min,
        r.sec,
        r.treatTimeSec,
        r.raw,
        r.prrInstant,
        r.prrIntervalVolumeL,
        r.dbvPercent,
        r.ufSpeedLh,
        r.ufVolumeL,
        r.sysBp,
        r.diaBp,
      ])
    );
  });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
 <Worksheet ss:Name="BV_PRR\u5206\u6790">
  <Table>
${rowsXml.join("\n")}
  </Table>
 </Worksheet>
</Workbook>`;
  const blob = new Blob([xml], { type: "application/vnd.ms-excel;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename.replace(/\.csv$/i, "") + "_BV_PRR分析.xls";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------- デモデータ生成（実データと同じCSV列を持つサンプルをその場で作成し、通常のアップロード処理に流す） ----------

function generateDemoCsvText(seed, dbvSlope, sysBpStart, diaBpStart, patientName) {
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  // 実データはAX列(50列目)に患者名が入っているため、デモでも同じ列位置になるよう
  // 意味のある10列の後にダミー列を挟んでAX列に患者名を配置する
  const DUMMY_COLUMN_COUNT = PATIENT_NAME_COLUMN_INDEX - 10; // 10列(意味のある列) の後、AX列の手前まで
  const dummyHeader = Array.from({ length: DUMMY_COLUMN_COUNT }, (_, i) => `col${i + 11}`).join(",");
  const lines = [
    `hour,min,sec,treat-time[sec],PRR[L/h]*100,dBV[%]*10,UFP-speed[L/h]*100,UF-volume[L]*100,sys-BP[mmHg],dia-BP[mmHg],${dummyHeader},patient-name`,
  ];
  let sysBp = sysBpStart;
  let diaBp = diaBpStart;
  let ufVolumeL = 0;
  const SAMPLES = 720; // 20秒間隔 x 720 = 4時間
  for (let i = 0; i < SAMPLES; i++) {
    const t = i * 20;
    const hour = 9 + Math.floor(t / 3600);
    const min = Math.floor((t % 3600) / 60);
    const sec = t % 60;
    const prrRaw = Math.round(35 + Math.sin(i / 40) * 12 + rand() * 8);
    const dbvRaw = Math.round((dbvSlope * i + (rand() - 0.5) * 2.5) * 10);
    const ufSpeedRaw = Math.round(48 + rand() * 10);
    ufVolumeL += (ufSpeedRaw / 100) * (20 / 3600);
    if (i % 54 === 0) {
      sysBp = Math.max(92, sysBp - Math.round(rand() * 2));
      diaBp = Math.max(52, diaBp - Math.round(rand() * 1.4));
    }
    const rowValues = [
      hour,
      min,
      sec,
      t,
      prrRaw,
      dbvRaw,
      ufSpeedRaw,
      Math.round(ufVolumeL * 100),
      sysBp,
      diaBp,
      ...Array(DUMMY_COLUMN_COUNT).fill(""),
      patientName,
    ];
    lines.push(rowValues.join(","));
  }
  return lines.join("\n");
}

// 患者2名×週3回（曜日違い）のサンプルセッション構成
const DEMO_SESSIONS = [
  { patient: "デモ患者A", date: "20260727", seed: 11, dbvSlope: -0.018, sysBp: 148, diaBp: 86 }, // 月
  { patient: "デモ患者A", date: "20260729", seed: 12, dbvSlope: -0.02, sysBp: 144, diaBp: 84 }, // 水
  { patient: "デモ患者A", date: "20260731", seed: 13, dbvSlope: -0.016, sysBp: 150, diaBp: 88 }, // 金
  { patient: "デモ患者B", date: "20260728", seed: 21, dbvSlope: -0.028, sysBp: 132, diaBp: 78 }, // 火
  { patient: "デモ患者B", date: "20260730", seed: 22, dbvSlope: -0.03, sysBp: 128, diaBp: 76 }, // 木
  { patient: "デモ患者B", date: "20260801", seed: 23, dbvSlope: -0.026, sysBp: 134, diaBp: 80 }, // 土
];

function buildDemoFiles() {
  return DEMO_SESSIONS.map((session) => {
    const filename = `${session.patient}_${session.date}_090000.csv`;
    const text = generateDemoCsvText(session.seed, session.dbvSlope, session.sysBp, session.diaBp, session.patient);
    return new File([text], filename, { type: "text/csv" });
  });
}

const PALETTE = ["#2DD4BF", "#F59E0B", "#818CF8", "#F472B6", "#34D399", "#FB923C", "#60A5FA", "#E879F9"];
const colorFor = (i) => PALETTE[i % PALETTE.length];

const monitorTick = (v) => (typeof v === "number" ? v.toFixed(1) : v);

function bpDot(color, changedKey) {
  return (props) => {
    const { cx, cy, payload } = props;
    if (!payload || !payload[changedKey]) return null;
    return <circle cx={cx} cy={cy} r={2.4} fill={color} stroke="none" />;
  };
}

// compare/overall両ビューで共通の「印刷ボタン＋患者タブ＋曜日タブ」ブロック
function ScopeTabs({
  presentPatients,
  overallPatient,
  selectPatient,
  presentWeekdays,
  overallSheet,
  selectSheet,
}) {
  return (
    <>
      <div className="no-print" style={{ marginBottom: 16 }}>
        <button
          onClick={() => window.print()}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            background: "#1B2536",
            color: "#E7ECF3",
            border: "1px solid #2A3548",
            borderRadius: 9,
            padding: "9px 16px",
            fontSize: 13,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          <Printer size={15} />
          PDFレポート出力（印刷）
        </button>
      </div>

      {/* 患者別シート切り替え */}
      {presentPatients.length > 1 && (
        <div className="no-print" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
          {[["all", "全患者"], ...presentPatients.map((p) => [p, p])].map(([key, label]) => (
            <button
              key={key}
              onClick={() => selectPatient(key)}
              style={{
                padding: "6px 12px",
                borderRadius: 7,
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                border: overallPatient === key ? "1px solid rgba(244,114,182,0.5)" : "1px solid #202B3D",
                background: overallPatient === key ? "rgba(244,114,182,0.14)" : "#0F1826",
                color: overallPatient === key ? "#F9A8D4" : "#8B9CB3",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {/* 曜日別シート切り替え */}
      {presentWeekdays.length > 1 && (
        <div className="no-print" style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
          {[["all", "全体"], ...presentWeekdays.map((w) => [w, `${w}曜日`])].map(([key, label]) => (
            <button
              key={key}
              onClick={() => selectSheet(key)}
              style={{
                padding: "6px 12px",
                borderRadius: 7,
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                border: overallSheet === key ? "1px solid rgba(129,140,248,0.5)" : "1px solid #202B3D",
                background: overallSheet === key ? "rgba(129,140,248,0.14)" : "#0F1826",
                color: overallSheet === key ? "#A5B4FC" : "#8B9CB3",
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
    </>
  );
}

// ---------- UI ----------

export default function BVPRRAnalyzerApp() {
  const [bases, setBases] = useState([]); // parseCsvBaseの結果（範囲情報を含む）を保持
  const [activeId, setActiveId] = useState(null);
  const [errors, setErrors] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [viewMode, setViewMode] = useState("single"); // "single" | "compare"
  const [chartOrder, setChartOrder] = useState(["triLine", "dbvRate", "dbvBp", "uf", "bp", "triple"]);
  const dragIdRef = useRef(null);

  const handleChartDragStart = (id) => (e) => {
    dragIdRef.current = id;
    e.dataTransfer.effectAllowed = "move";
  };
  const handleChartDragOver = (e) => {
    e.preventDefault();
  };
  const handleChartDrop = (targetId) => (e) => {
    e.preventDefault();
    const draggedId = dragIdRef.current;
    if (!draggedId || draggedId === targetId) return;
    setChartOrder((prev) => {
      const next = [...prev];
      const from = next.indexOf(draggedId);
      const to = next.indexOf(targetId);
      if (from === -1 || to === -1) return prev;
      next.splice(from, 1);
      next.splice(to, 0, draggedId);
      return next;
    });
    dragIdRef.current = null;
  };
  const dragSourceProps = (id) => ({
    draggable: true,
    onDragStart: handleChartDragStart(id),
  });
  const dragTargetProps = (id) => ({
    onDragOver: handleChartDragOver,
    onDrop: handleChartDrop(id),
  });

  const inputRef = useRef(null);

  const handleFiles = useCallback(async (fileList) => {
    setIsProcessing(true);
    const newBases = [];
    const newErrors = [];

    for (const file of Array.from(fileList)) {
      if (!file.name.toLowerCase().endsWith(".csv")) {
        newErrors.push(`${file.name}: CSVファイルではありません`);
        continue;
      }
      try {
        const buffer = await file.arrayBuffer();
        const text = decodeBytes(buffer);
        const base = parseCsvBase(text, file.name);
        newBases.push({ id: `${file.name}-${Date.now()}-${Math.random()}`, ...base });
      } catch (e) {
        newErrors.push(`${file.name}: ${e.message}`);
      }
    }

    setBases((prev) => {
      const combined = [...prev, ...newBases];
      if (newBases.length > 0) setActiveId(newBases[0].id);
      return combined;
    });
    setErrors(newErrors);
    setIsProcessing(false);
  }, []);

  const loadDemoData = useCallback(() => {
    handleFiles(buildDemoFiles());
  }, [handleFiles]);

  const onDrop = useCallback(
    (e) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files);
    },
    [handleFiles]
  );

  const removeResult = (id) => {
    setBases((prev) => {
      const next = prev.filter((r) => r.id !== id);
      if (activeId === id) setActiveId(next.length ? next[0].id : null);
      if (next.length <= 1) setViewMode("single");
      return next;
    });
  };

  const updateRange = (id, patch) => {
    setBases((prev) => prev.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  };

  const resetRange = (id) => {
    setBases((prev) =>
      prev.map((b) => (b.id === id ? { ...b, rangeStart: b.autoRange.startIdx, rangeEnd: b.autoRange.endIdx } : b))
    );
  };

  // 全ファイル分をまとめて派生データ化（範囲変更のたびに再計算）
  const results = useMemo(() => bases.map((b) => ({ ...b, ...computeDerived(b) })), [bases]);

  const active = results.find((r) => r.id === activeId);
  const activeBase = bases.find((b) => b.id === activeId);

  const tripleScatterData = useMemo(() => {
    if (!active || !active.hasDbv || !active.hasUf) return [];
    return active.rows.map((r) => ({ x: r.dbvPercent, y: r.prrInstant, z: r.ufSpeedLh }));
  }, [active]);

  const numericDomain = (arr) => {
    if (!arr.length) return [0, 1];
    const min = Math.min(...arr);
    const max = Math.max(...arr);
    const pad = (max - min) * 0.08 || Math.abs(max) * 0.1 || 1;
    return [min - pad, max + pad];
  };

  const tripleXDomain = useMemo(
    () => numericDomain(tripleScatterData.map((d) => d.x)),
    [tripleScatterData]
  );
  const tripleYDomain = useMemo(
    () => numericDomain(tripleScatterData.map((d) => d.y)),
    [tripleScatterData]
  );

  const chronoResults = useMemo(
    () =>
      [...results].sort(
        (a, b) => (a.sessionTimestamp ?? Infinity) - (b.sessionTimestamp ?? Infinity)
      ),
    [results]
  );

  const [overallPatient, setOverallPatient] = useState("all"); // "all" | patientLabel
  const [overallSheet, setOverallSheet] = useState("all"); // "all" | "月" | "火" | ...
  const [singlePatient, setSinglePatient] = useState("all"); // "all" | patientLabel（個別ビューのファイル一覧の絞り込み）

  const selectPatient = (key) => {
    setOverallPatient(key);
    setOverallSheet("all");
    setGeneratedPrompt(null);
    setCopyStatus("idle");
  };
  const selectSheet = (key) => {
    setOverallSheet(key);
    setGeneratedPrompt(null);
    setCopyStatus("idle");
  };

  // データに実際に登場する患者を、初出順に並べる
  const presentPatients = useMemo(() => {
    const seen = [];
    for (const r of chronoResults) {
      if (!seen.includes(r.patientLabel)) seen.push(r.patientLabel);
    }
    return seen;
  }, [chronoResults]);

  // 個別ビューのファイル一覧を、選択中の患者タブで絞り込む
  const singleVisibleResults = useMemo(() => {
    if (singlePatient === "all") return results;
    return results.filter((r) => r.patientLabel === singlePatient);
  }, [results, singlePatient]);

  const selectSinglePatient = (key) => {
    setSinglePatient(key);
    const visible = key === "all" ? results : results.filter((r) => r.patientLabel === key);
    if (visible.length > 0 && !visible.some((r) => r.id === activeId)) {
      setActiveId(visible[0].id);
    }
  };

  // 選択中の患者でまず絞り込み（"all"なら全患者）
  const patientResults = useMemo(() => {
    if (overallPatient === "all") return chronoResults;
    return chronoResults.filter((r) => r.patientLabel === overallPatient);
  }, [chronoResults, overallPatient]);

  // データに実際に登場する曜日を、月→日の順で並べる（選択中の患者の範囲内で）
  const presentWeekdays = useMemo(() => {
    const order = ["月", "火", "水", "木", "金", "土", "日"];
    const present = new Set(patientResults.map((r) => r.weekdayLabel).filter(Boolean));
    return order.filter((w) => present.has(w));
  }, [patientResults]);

  const sheetResults = useMemo(() => {
    if (overallSheet === "all") return patientResults;
    return patientResults.filter((r) => r.weekdayLabel === overallSheet);
  }, [patientResults, overallSheet]);

  const scopeLabel = `${overallPatient === "all" ? "全患者" : overallPatient} ／ ${
    overallSheet === "all" ? "全曜日" : `${overallSheet}曜日`
  }`;

  const [generatedPrompt, setGeneratedPrompt] = useState(null);
  const [copyStatus, setCopyStatus] = useState("idle"); // "idle" | "copied"

  const generateAnalysisPrompt = useCallback(() => {
    const patientPhrase =
      overallPatient === "all" && presentPatients.length > 1 ? "複数患者の" : "同一患者の";
    // 外部AIチャットに貼り付けて使う想定のため、実患者名は送信せず仮名(患者A/患者B...)に置き換える
    // patientId は AX列の患者名 → ファイル名由来のIDの順で解決するが、どちらも取れない
    // セッションは patientId が null になるため、そのままキーにすると別患者同士が
    // 同じ仮名に統合されてしまう。null の場合はセッション固有の id をキーにして分離する。
    const anonLabels = new Map();
    sheetResults.forEach((r) => {
      const key = r.patientId ?? `__unresolved_${r.id}`;
      if (!anonLabels.has(key)) {
        anonLabels.set(key, `患者${String.fromCharCode(65 + anonLabels.size)}`);
      }
    });
    const sessionsForPrompt = sheetResults.map((r) => ({
      患者ID: anonLabels.get(r.patientId ?? `__unresolved_${r.id}`),
      セッション: r.shortLabel,
      PRR積算量合計_L: Number(r.totalPrrVolumeL.toFixed(4)),
      最大ΔBV低下率: r.hasDbv ? Number(r.minDbv.toFixed(1)) : null,
      総除水量_L: r.hasUf ? Number(r.totalUfVolumeL.toFixed(2)) : null,
      収縮期血圧低下量_mmHg: r.hasBp ? r.sysDrop : null,
      ΔBVとPRRの相関係数: r.hasDbv ? r.corrDbvPrr : null,
      除水速度とPRRの相関係数: r.hasUf ? r.corrUfPrr : null,
    }));

    const prompt = `あなたは血液透析（除水・血漿再充填ダイナミクス）データを専門的にレビューする臨床工学技士です。
以下は${patientPhrase}複数回の透析セッションから抽出した数値データです（実施日時の昇順）。
${patientPhrase === "複数患者の" ? "各セッションの「患者ID」で患者ごとの傾向の違いにも注意してください。\n" : ""}このデータのみをもとに、下記の観点から詳細かつ専門的に分析してください。

【分析してほしい観点】
1. PRR（血漿再充填）・ΔBV（血液濃縮）の全体的な傾向と、セッションを追うごとの経時的な変化
2. セッション間のばらつきとその要因として考えられること
3. 除水速度・除水量とΔBV/PRRの関係性から読み取れる血漿再充填能力の評価
4. 血圧低下とΔBVの関連から示唆される循環動態への影響
5. データ上、特に注意が必要と考えられるセッション・時間帯とその根拠
6. 次回以降の透析条件設定（除水速度・除水プログラムなど）を検討する上での実務的な示唆

【出力形式】
- 見出し付きのMarkdown形式で、日本語で詳細に記述してください
- 数値の正常/異常を医学的に断定せず、あくまで「データの傾向として読み取れること」として記述してください
- 診断や治療方針の決定はできない旨を踏まえつつ、臨床工学技士が次回の設定検討に使える実務的な視点でまとめてください

セッションデータ（JSON）:
${JSON.stringify(sessionsForPrompt, null, 2)}

用語補足:
- PRR積算量合計: 血漿再充填の推定量（治療中の合計、単位L）
- 最大ΔBV低下率: 血液量減少の最大値（マイナスが大きいほど濃縮）
- ΔBVとPRRの相関: 負の相関が強いほど、除水に対して血漿再充填が追いついていない可能性
- 除水速度とPRRの相関: 除水速度の変化とPRRの連動性`;

    setGeneratedPrompt(prompt);
    setCopyStatus("idle");
  }, [sheetResults, overallPatient, presentPatients]);

  const copyPrompt = useCallback(async () => {
    if (!generatedPrompt) return;
    try {
      await navigator.clipboard.writeText(generatedPrompt);
      setCopyStatus("copied");
      setTimeout(() => setCopyStatus("idle"), 2000);
    } catch (e) {
      console.error("Clipboard copy error:", e);
    }
  }, [generatedPrompt]);

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "#0B1220",
        fontFamily: "'IBM Plex Sans', 'Hiragino Sans', sans-serif",
        color: "#E7ECF3",
        padding: "32px 20px",
      }}
    >
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans+JP:wght@400;500;700&display=swap"
      />
      <div style={{ maxWidth: 1080, margin: "0 auto" }}>
        {/* ヘッダー */}
        <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 6 }}>
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 10,
              background: "linear-gradient(135deg,#0F766E,#134E4A)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              boxShadow: "0 0 0 1px rgba(45,212,191,0.25)",
            }}
          >
            <Activity size={20} color="#5EEAD4" />
          </div>
          <div>
            <div
              style={{
                fontSize: 20,
                fontWeight: 700,
                letterSpacing: 0.2,
                fontFamily: "'IBM Plex Sans JP',sans-serif",
              }}
            >
              BV / PRR 分析ツール
            </div>
            <div style={{ fontSize: 12.5, color: "#8B9CB3" }}>
              ΔBV・除水・血圧をPRRとあわせて可視化。区間は手動調整も可能です
            </div>
          </div>
        </div>

        {/* ドロップゾーン */}
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={onDrop}
          onClick={() => inputRef.current?.click()}
          style={{
            marginTop: 24,
            border: `1.5px dashed ${isDragging ? "#2DD4BF" : "#2A3548"}`,
            background: isDragging ? "rgba(45,212,191,0.06)" : "#0F1826",
            borderRadius: 14,
            padding: "36px 24px",
            textAlign: "center",
            cursor: "pointer",
            transition: "all 0.15s ease",
          }}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".csv"
            multiple
            style={{ display: "none" }}
            onChange={(e) => e.target.files?.length && handleFiles(e.target.files)}
          />
          <UploadCloud size={26} color={isDragging ? "#2DD4BF" : "#5B6B85"} style={{ marginBottom: 10 }} />
          <div style={{ fontSize: 14.5, fontWeight: 500, color: "#CBD5E1" }}>
            CSVファイルをドロップ、またはクリックして選択
          </div>
          <div style={{ fontSize: 12, color: "#647089", marginTop: 4 }}>
            複数ファイルの同時投入に対応
          </div>
        </div>

        {results.length === 0 && !isProcessing && (
          <div style={{ marginTop: 12, display: "flex", justifyContent: "center" }}>
            <button
              onClick={loadDemoData}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 7,
                background: "transparent",
                color: "#5EEAD4",
                border: "1px solid rgba(45,212,191,0.35)",
                borderRadius: 8,
                padding: "8px 16px",
                fontSize: 12.5,
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              <Activity size={13} />
              デモデータを試す（患者2名×週3回のサンプルを読み込み）
            </button>
          </div>
        )}

        {isProcessing && <div style={{ marginTop: 12, fontSize: 13, color: "#5EEAD4" }}>処理中...</div>}

        {errors.length > 0 && (
          <div
            style={{
              marginTop: 16,
              background: "rgba(248,113,113,0.08)",
              border: "1px solid rgba(248,113,113,0.35)",
              borderRadius: 10,
              padding: "12px 14px",
            }}
          >
            {errors.map((err, i) => (
              <div
                key={i}
                style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, color: "#FCA5A5" }}
              >
                <FileWarning size={15} style={{ marginTop: 1, flexShrink: 0 }} />
                <span>{err}</span>
              </div>
            ))}
          </div>
        )}

        {results.length > 1 && (
          <div style={{ marginTop: 24, display: "flex", gap: 8 }}>
            {[
              ["single", "個別ビュー"],
              ["compare", "比較ビュー"],
              ["overall", "総合分析"],
            ].map(([key, label]) => (
              <button
                key={key}
                onClick={() => setViewMode(key)}
                style={{
                  padding: "7px 14px",
                  borderRadius: 8,
                  fontSize: 12.5,
                  fontWeight: 500,
                  cursor: "pointer",
                  border: viewMode === key ? "1px solid rgba(45,212,191,0.5)" : "1px solid #202B3D",
                  background: viewMode === key ? "rgba(45,212,191,0.12)" : "#0F1826",
                  color: viewMode === key ? "#5EEAD4" : "#8B9CB3",
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}

        {results.length > 0 && viewMode === "single" && (
          <div style={{ marginTop: 20, display: "flex", gap: 20, alignItems: "flex-start", flexWrap: "wrap" }}>
            {/* ファイル一覧 */}
            <div style={{ width: 240, flexShrink: 0 }}>
              {presentPatients.length > 1 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                  {[["all", "全患者"], ...presentPatients.map((p) => [p, p])].map(([key, label]) => (
                    <button
                      key={key}
                      onClick={() => selectSinglePatient(key)}
                      style={{
                        padding: "6px 12px",
                        borderRadius: 7,
                        fontSize: 12,
                        fontWeight: 500,
                        cursor: "pointer",
                        border: singlePatient === key ? "1px solid rgba(244,114,182,0.5)" : "1px solid #202B3D",
                        background: singlePatient === key ? "rgba(244,114,182,0.14)" : "#0F1826",
                        color: singlePatient === key ? "#F9A8D4" : "#8B9CB3",
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <div
                style={{
                  fontSize: 11.5,
                  color: "#647089",
                  marginBottom: 8,
                  letterSpacing: 0.5,
                  textTransform: "uppercase",
                }}
              >
                読み込み済み ({singleVisibleResults.length})
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {singleVisibleResults.map((r) => (
                  <div
                    key={r.id}
                    onClick={() => setActiveId(r.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "9px 10px",
                      borderRadius: 8,
                      cursor: "pointer",
                      background: activeId === r.id ? "rgba(45,212,191,0.12)" : "transparent",
                      border: activeId === r.id ? "1px solid rgba(45,212,191,0.4)" : "1px solid transparent",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                      <ChevronRight
                        size={13}
                        color={activeId === r.id ? "#5EEAD4" : "#4A5670"}
                        style={{ flexShrink: 0 }}
                      />
                      <span
                        style={{
                          fontSize: 12.5,
                          color: activeId === r.id ? "#E7ECF3" : "#9AA7BD",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          fontFamily: "'IBM Plex Mono',monospace",
                        }}
                        title={r.filename}
                      >
                        {presentPatients.length > 1 && singlePatient === "all" ? `[${r.patientLabel}] ` : ""}
                        {r.filename}
                      </span>
                    </div>
                    <X
                      size={13}
                      color="#4A5670"
                      style={{ flexShrink: 0 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        removeResult(r.id);
                      }}
                    />
                  </div>
                ))}
              </div>

              {activeBase && activeBase.missingColumns.length > 0 && (
                <div
                  style={{
                    marginTop: 14,
                    fontSize: 11,
                    color: "#F59E0B",
                    background: "rgba(245,158,11,0.08)",
                    border: "1px solid rgba(245,158,11,0.3)",
                    borderRadius: 8,
                    padding: "8px 10px",
                    lineHeight: 1.6,
                  }}
                >
                  このファイルには次の列が見つからず、該当分析はスキップされています:
                  <br />
                  {activeBase.missingColumns.join(" / ")}
                </div>
              )}
            </div>

            {/* 詳細パネル */}
            {active && activeBase && (
              <div className="report-print-area" style={{ flex: 1, minWidth: 380, display: "flex", flexDirection: "column" }}>
                <div className="print-only" style={{ order: -30, marginBottom: 14 }}>
                  <div style={{ fontSize: 18, fontWeight: 700, color: "#111827" }}>透析 BV / PRR 分析レポート</div>
                  <div style={{ fontSize: 12, color: "#374151", marginTop: 4 }}>
                    ファイル: {active.filename} ／ 抽出範囲: {active.startLabel} 〜 {active.endLabel} ／ 作成日時:{" "}
                    {new Date().toLocaleString("ja-JP")}
                  </div>
                </div>
                {/* 抽出範囲の手動調整 */}
                <div
                  className="no-print"
                  style={{
                    order: -20,
                    background: "#0F1826",
                    border: "1px solid #202B3D",
                    borderRadius: 10,
                    padding: "12px 14px",
                    marginBottom: 16,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 8,
                    }}
                  >
                    <div style={{ fontSize: 11.5, color: "#8B9CB3" }}>
                      抽出範囲（自動検出: {activeBase.autoRange.startIdx} 〜 {activeBase.autoRange.endIdx} 行目）
                    </div>
                    <button
                      onClick={() => resetRange(activeBase.id)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        fontSize: 11,
                        color: "#5EEAD4",
                        background: "transparent",
                        border: "1px solid rgba(45,212,191,0.35)",
                        borderRadius: 6,
                        padding: "3px 8px",
                        cursor: "pointer",
                      }}
                    >
                      <RotateCcw size={11} />
                      自動検出に戻す
                    </button>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 11, color: "#647089", width: 60 }}>開始 {active.startLabel}</span>
                      <input
                        type="range"
                        min={0}
                        max={active.maxIdx}
                        value={activeBase.rangeStart}
                        onChange={(e) =>
                          updateRange(activeBase.id, { rangeStart: Math.min(Number(e.target.value), activeBase.rangeEnd - 1) })
                        }
                        style={{ flex: 1, accentColor: "#2DD4BF" }}
                      />
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                      <span style={{ fontSize: 11, color: "#647089", width: 60 }}>終了 {active.endLabel}</span>
                      <input
                        type="range"
                        min={0}
                        max={active.maxIdx}
                        value={activeBase.rangeEnd}
                        onChange={(e) =>
                          updateRange(activeBase.id, { rangeEnd: Math.max(Number(e.target.value), activeBase.rangeStart + 1) })
                        }
                        style={{ flex: 1, accentColor: "#2DD4BF" }}
                      />
                    </div>
                  </div>
                </div>

                {/* サマリー */}
                <div
                  style={{
                    order: -10,
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))",
                    gap: 10,
                    marginBottom: 16,
                  }}
                >
                  {[
                    ["開始時刻", active.startLabel],
                    ["終了時刻", active.endLabel],
                    ...(active.hasDbv ? [["最大ΔBV低下", `${active.minDbv.toFixed(1)}% (${active.minDbvTime})`]] : []),
                    ["PRR積算量合計", `${active.totalPrrVolumeL.toFixed(4)} L`],
                    ...(active.hasDbv ? [["ΔBV-PRR相関(r)", corrLabel(active.corrDbvPrr)]] : []),
                    ...(active.hasUf ? [["総除水量", `${active.totalUfVolumeL.toFixed(2)} L`]] : []),
                    ...(active.hasBp
                      ? [
                          ["最低血圧(収縮期)", `${active.minSysBp} mmHg (${active.minSysBpTime})`],
                          ["血圧低下量(収縮期)", `${active.sysDrop} mmHg`],
                        ]
                      : []),
                    ...(active.hasBp && active.hasDbv ? [["ΔBV-血圧相関(r)", corrLabel(active.corrDbvSys)]] : []),
                    ...(active.hasUf ? [["除水速度-PRR相関(r)", corrLabel(active.corrUfPrr)]] : []),
                  ].map(([label, value]) => {
                    const isTotal = label === "PRR積算量合計";
                    return (
                      <div
                        key={label}
                        style={{
                          background: isTotal ? "rgba(45,212,191,0.08)" : "#0F1826",
                          border: isTotal ? "1px solid rgba(45,212,191,0.4)" : "1px solid #202B3D",
                          borderRadius: 10,
                          padding: "10px 12px",
                        }}
                      >
                        <div style={{ fontSize: 10.5, color: isTotal ? "#5EEAD4" : "#647089", marginBottom: 4 }}>
                          {label}
                        </div>
                        <div
                          style={{
                            fontSize: 14.5,
                            fontFamily: "'IBM Plex Mono',monospace",
                            fontWeight: 500,
                            color: isTotal ? "#5EEAD4" : "#E7ECF3",
                          }}
                        >
                          {value}
                        </div>
                      </div>
                    );
                  })}
                </div>

                {/* ΔBV・PRR瞬時値・除水速度 3本の推移折れ線グラフ */}
                {active.hasDbv && active.hasUf && (
                  <div
                    {...dragTargetProps("triLine")}
                    style={{
                      order: chartOrder.indexOf("triLine"),
                      background: "#050B14",
                      border: "1px solid #1B2536",
                      borderRadius: 12,
                      padding: "18px 14px 6px",
                      boxShadow: "inset 0 0 40px rgba(15,118,110,0.08)",
                      marginBottom: 18,
                    }}
                  >
                    <div
                      {...dragSourceProps("triLine")}
                      className="no-print"
                      style={{ display: "flex", alignItems: "center", gap: 6, cursor: "grab", marginBottom: 6 }}
                    >
                      <GripVertical size={13} color="#4A5670" />
                      <span style={{ fontSize: 10, color: "#4A5670" }}>ドラッグで並び替え</span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: 4,
                        paddingLeft: 6,
                        flexWrap: "wrap",
                        rowGap: 4,
                      }}
                    >
                      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                        <div
                          style={{
                            fontSize: 11.5,
                            color: "#F59E0B",
                            fontFamily: "'IBM Plex Mono',monospace",
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                          }}
                        >
                          <Droplet size={11} /> ΔBV 移動平均(50区間, %)
                        </div>
                        <div
                          style={{
                            fontSize: 11.5,
                            color: "#5EEAD4",
                            fontFamily: "'IBM Plex Mono',monospace",
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                          }}
                        >
                          <TrendingDown size={11} /> PRR 瞬時値 (L/h)
                        </div>
                        <div
                          style={{
                            fontSize: 11.5,
                            color: "#818CF8",
                            fontFamily: "'IBM Plex Mono',monospace",
                          }}
                        >
                          除水速度 (L/h)
                        </div>
                      </div>
                      <div style={{ fontSize: 11, color: "#3F4C63" }}>治療経過時間 (分)</div>
                    </div>
                    <ResponsiveContainer width="100%" height={280}>
                      <LineChart data={active.rows} margin={{ top: 4, right: 14, left: -8, bottom: 4 }}>
                        <CartesianGrid stroke="#152036" strokeDasharray="2 4" vertical={false} />
                        <XAxis
                          dataKey="treatTimeMin"
                          tick={{ fill: "#8B9CB3", fontSize: 10.5 }}
                          tickFormatter={monitorTick}
                          stroke="#1B2536"
                          minTickGap={40}
                        />
                        <YAxis
                          yAxisId="dbv"
                          tick={{ fill: "#F59E0B", fontSize: 10.5 }}
                          stroke="#1B2536"
                          width={44}
                        />
                        <YAxis
                          yAxisId="prr"
                          orientation="right"
                          tick={{ fill: "#5EEAD4", fontSize: 10.5 }}
                          stroke="#1B2536"
                          width={44}
                        />
                        <YAxis yAxisId="uf" hide domain={["auto", "auto"]} />
                        <ReferenceLine y={0} yAxisId="dbv" stroke="#2A3548" />
                        <Legend wrapperStyle={{ fontSize: 11, color: "#CBD5E1" }} />
                        <Tooltip
                          contentStyle={{
                            background: "#0F1826",
                            border: "1px solid #2A3548",
                            borderRadius: 8,
                            fontSize: 12,
                          }}
                          labelFormatter={(v) => `${v} 分`}
                          formatter={(value, name) => {
                            if (name === "ΔBV移動平均(50区間,%)") return [`${value.toFixed(2)}%`, "ΔBV移動平均"];
                            if (name === "PRR瞬時値[L/h]") return [value.toFixed(3), "PRR瞬時値"];
                            return [`${value.toFixed(2)} L/h`, "除水速度"];
                          }}
                        />
                        <Line
                          yAxisId="dbv"
                          type="monotone"
                          dataKey="dbvMA50"
                          name="ΔBV移動平均(50区間,%)"
                          stroke="#F59E0B"
                          strokeWidth={1.6}
                          dot={false}
                          isAnimationActive={false}
                        />
                        <Line
                          yAxisId="prr"
                          type="monotone"
                          dataKey="prrInstant"
                          name="PRR瞬時値[L/h]"
                          stroke="#2DD4BF"
                          strokeWidth={1.6}
                          dot={false}
                          isAnimationActive={false}
                        />
                        <Line
                          yAxisId="uf"
                          type="monotone"
                          dataKey="ufSpeedLh"
                          name="除水速度[L/h]"
                          stroke="#818CF8"
                          strokeWidth={1.4}
                          strokeDasharray="4 2"
                          dot={false}
                          isAnimationActive={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                    <div style={{ fontSize: 10, color: "#4A5670", marginTop: 4, paddingLeft: 6 }}>
                      ※ ΔBVは50区間移動平均、除水速度は左右軸とは別スケール(非表示軸)で重ねて表示しています。形状の連動をご覧ください
                    </div>
                  </div>
                )}

                {/* ΔBV低下速度（脱水評価：血液濃縮の進行スピード） */}
                {active.hasDbv && (
                  <div
                    {...dragTargetProps("dbvRate")}
                    style={{
                      order: chartOrder.indexOf("dbvRate"),
                      background: "#050B14",
                      border: "1px solid #1B2536",
                      borderRadius: 12,
                      padding: "18px 14px 6px",
                      boxShadow: "inset 0 0 40px rgba(15,118,110,0.08)",
                      marginBottom: 18,
                    }}
                  >
                    <div
                      {...dragSourceProps("dbvRate")}
                      className="no-print"
                      style={{ display: "flex", alignItems: "center", gap: 6, cursor: "grab", marginBottom: 6 }}
                    >
                      <GripVertical size={13} color="#4A5670" />
                      <span style={{ fontSize: 10, color: "#4A5670" }}>ドラッグで並び替え</span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: 4,
                        paddingLeft: 6,
                      }}
                    >
                      <div
                        style={{
                          fontSize: 11.5,
                          color: "#F87171",
                          fontFamily: "'IBM Plex Mono',monospace",
                          display: "flex",
                          alignItems: "center",
                          gap: 4,
                        }}
                      >
                        <TrendingDown size={11} /> ΔBV低下速度（脱水評価, %/時間）
                      </div>
                      <div style={{ fontSize: 11, color: "#3F4C63" }}>治療経過時間 (分)</div>
                    </div>
                    <ResponsiveContainer width="100%" height={220}>
                      <LineChart data={active.rows} margin={{ top: 4, right: 14, left: -8, bottom: 4 }}>
                        <CartesianGrid stroke="#152036" strokeDasharray="2 4" vertical={false} />
                        <XAxis
                          dataKey="treatTimeMin"
                          tick={{ fill: "#8B9CB3", fontSize: 10.5 }}
                          tickFormatter={monitorTick}
                          stroke="#1B2536"
                          minTickGap={40}
                        />
                        <YAxis tick={{ fill: "#8B9CB3", fontSize: 10.5 }} stroke="#1B2536" width={44} />
                        <ReferenceLine y={0} stroke="#2A3548" />
                        <Tooltip
                          contentStyle={{
                            background: "#0F1826",
                            border: "1px solid #2A3548",
                            borderRadius: 8,
                            fontSize: 12,
                          }}
                          labelFormatter={(v) => `${v} 分`}
                          formatter={(v) => [`${v.toFixed(2)} %/h`, "ΔBV低下速度"]}
                        />
                        <Line
                          type="monotone"
                          dataKey="dbvRatePerHour"
                          stroke="#F87171"
                          strokeWidth={1.8}
                          dot={false}
                          isAnimationActive={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                    <div style={{ fontSize: 10, color: "#4A5670", marginTop: 4, paddingLeft: 6 }}>
                      ※ ΔBV移動平均の直近15サンプル(約5分)あたりの傾きです。マイナス方向に大きいほど血液濃縮＝脱水が急速に進行していることを示します
                    </div>
                  </div>
                )}

                {/* ΔBV × 収縮期血圧 重ね表示（脱水評価：血液濃縮と血圧低下の連動確認） */}
                {active.hasDbv && active.hasBp && (
                  <div
                    {...dragTargetProps("dbvBp")}
                    style={{
                      order: chartOrder.indexOf("dbvBp"),
                      background: "#050B14",
                      border: "1px solid #1B2536",
                      borderRadius: 12,
                      padding: "18px 14px 6px",
                      boxShadow: "inset 0 0 40px rgba(15,118,110,0.08)",
                      marginBottom: 18,
                    }}
                  >
                    <div
                      {...dragSourceProps("dbvBp")}
                      className="no-print"
                      style={{ display: "flex", alignItems: "center", gap: 6, cursor: "grab", marginBottom: 6 }}
                    >
                      <GripVertical size={13} color="#4A5670" />
                      <span style={{ fontSize: 10, color: "#4A5670" }}>ドラッグで並び替え</span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: 4,
                        paddingLeft: 6,
                        flexWrap: "wrap",
                        rowGap: 4,
                      }}
                    >
                      <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                        <div
                          style={{
                            fontSize: 11.5,
                            color: "#F59E0B",
                            fontFamily: "'IBM Plex Mono',monospace",
                            display: "flex",
                            alignItems: "center",
                            gap: 4,
                          }}
                        >
                          <Droplet size={11} /> ΔBV 移動平均(50区間, %)
                        </div>
                        <div style={{ fontSize: 11.5, color: "#FB923C", fontFamily: "'IBM Plex Mono',monospace" }}>
                          収縮期血圧 (mmHg)
                        </div>
                      </div>
                      <div style={{ fontSize: 11, color: "#3F4C63" }}>治療経過時間 (分) ・点＝血圧実測タイミング</div>
                    </div>
                    <ResponsiveContainer width="100%" height={260}>
                      <LineChart data={active.rows} margin={{ top: 4, right: 14, left: -8, bottom: 4 }}>
                        <CartesianGrid stroke="#152036" strokeDasharray="2 4" vertical={false} />
                        <XAxis
                          dataKey="treatTimeMin"
                          tick={{ fill: "#8B9CB3", fontSize: 10.5 }}
                          tickFormatter={monitorTick}
                          stroke="#1B2536"
                          minTickGap={40}
                        />
                        <YAxis
                          yAxisId="dbv"
                          tick={{ fill: "#F59E0B", fontSize: 10.5 }}
                          stroke="#1B2536"
                          width={44}
                        />
                        <YAxis
                          yAxisId="sys"
                          orientation="right"
                          tick={{ fill: "#FB923C", fontSize: 10.5 }}
                          stroke="#1B2536"
                          width={44}
                        />
                        <ReferenceLine y={0} yAxisId="dbv" stroke="#2A3548" />
                        <Tooltip
                          contentStyle={{
                            background: "#0F1826",
                            border: "1px solid #2A3548",
                            borderRadius: 8,
                            fontSize: 12,
                          }}
                          labelFormatter={(v) => `${v} 分`}
                          formatter={(value, name) => {
                            if (name === "ΔBV移動平均(50区間,%)") return [`${value.toFixed(2)}%`, "ΔBV移動平均"];
                            return [`${value} mmHg`, "収縮期血圧"];
                          }}
                        />
                        <Line
                          yAxisId="dbv"
                          type="monotone"
                          dataKey="dbvMA50"
                          name="ΔBV移動平均(50区間,%)"
                          stroke="#F59E0B"
                          strokeWidth={1.8}
                          dot={false}
                          isAnimationActive={false}
                        />
                        <Line
                          yAxisId="sys"
                          type="stepAfter"
                          dataKey="sysBp"
                          name="収縮期血圧"
                          stroke="#FB923C"
                          strokeWidth={1.6}
                          dot={bpDot("#FB923C", "sysBpChanged")}
                          isAnimationActive={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                    <div style={{ fontSize: 10, color: "#4A5670", marginTop: 4, paddingLeft: 6 }}>
                      ※ ΔBVの低下(血液濃縮)と収縮期血圧の低下が同時に進んでいる場合、脱水による循環動態への影響が疑われます
                    </div>
                  </div>
                )}

                {/* 除水速度・除水量チャート */}
                {active.hasUf && (
                  <div
                    {...dragTargetProps("uf")}
                    style={{
                      order: chartOrder.indexOf("uf"),
                      background: "#050B14",
                      border: "1px solid #1B2536",
                      borderRadius: 12,
                      padding: "18px 14px 6px",
                      boxShadow: "inset 0 0 40px rgba(15,118,110,0.08)",
                      marginBottom: 18,
                    }}
                  >
                    <div
                      {...dragSourceProps("uf")}
                      className="no-print"
                      style={{ display: "flex", alignItems: "center", gap: 6, cursor: "grab", marginBottom: 6 }}
                    >
                      <GripVertical size={13} color="#4A5670" />
                      <span style={{ fontSize: 10, color: "#4A5670" }}>ドラッグで並び替え</span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: 4,
                        paddingLeft: 6,
                      }}
                    >
                      <div style={{ display: "flex", gap: 14 }}>
                        <div style={{ fontSize: 11.5, color: "#818CF8", fontFamily: "'IBM Plex Mono',monospace" }}>
                          除水速度 (L/h)
                        </div>
                        <div style={{ fontSize: 11.5, color: "#F472B6", fontFamily: "'IBM Plex Mono',monospace" }}>
                          累積除水量 (L)
                        </div>
                      </div>
                      <div style={{ fontSize: 11, color: "#3F4C63" }}>治療経過時間 (分)</div>
                    </div>
                    <ResponsiveContainer width="100%" height={240}>
                      <LineChart data={active.rows} margin={{ top: 4, right: 14, left: -8, bottom: 4 }}>
                        <CartesianGrid stroke="#152036" strokeDasharray="2 4" vertical={false} />
                        <XAxis
                          dataKey="treatTimeMin"
                          tick={{ fill: "#4A5670", fontSize: 10.5 }}
                          tickFormatter={monitorTick}
                          stroke="#1B2536"
                          minTickGap={40}
                        />
                        <YAxis yAxisId="speed" tick={{ fill: "#4A5670", fontSize: 10.5 }} stroke="#1B2536" width={44} />
                        <YAxis
                          yAxisId="vol"
                          orientation="right"
                          tick={{ fill: "#4A5670", fontSize: 10.5 }}
                          stroke="#1B2536"
                          width={44}
                        />
                        <Tooltip
                          contentStyle={{
                            background: "#0F1826",
                            border: "1px solid #2A3548",
                            borderRadius: 8,
                            fontSize: 12,
                          }}
                          labelFormatter={(v) => `${v} 分`}
                          formatter={(v, name) =>
                            name === "ufSpeedLh" ? [`${v.toFixed(2)} L/h`, "除水速度"] : [`${v.toFixed(2)} L`, "累積除水量"]
                          }
                        />
                        <Line
                          yAxisId="speed"
                          type="monotone"
                          dataKey="ufSpeedLh"
                          stroke="#818CF8"
                          strokeWidth={1.4}
                          dot={false}
                          isAnimationActive={false}
                        />
                        <Line
                          yAxisId="vol"
                          type="monotone"
                          dataKey="ufVolumeL"
                          stroke="#F472B6"
                          strokeWidth={1.4}
                          dot={false}
                          isAnimationActive={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* 血圧チャート（実測点にドット表示） */}
                {active.hasBp && (
                  <div
                    {...dragTargetProps("bp")}
                    style={{
                      order: chartOrder.indexOf("bp"),
                      background: "#050B14",
                      border: "1px solid #1B2536",
                      borderRadius: 12,
                      padding: "18px 14px 6px",
                      boxShadow: "inset 0 0 40px rgba(15,118,110,0.08)",
                      marginBottom: 18,
                    }}
                  >
                    <div
                      {...dragSourceProps("bp")}
                      className="no-print"
                      style={{ display: "flex", alignItems: "center", gap: 6, cursor: "grab", marginBottom: 6 }}
                    >
                      <GripVertical size={13} color="#4A5670" />
                      <span style={{ fontSize: 10, color: "#4A5670" }}>ドラッグで並び替え</span>
                    </div>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        marginBottom: 4,
                        paddingLeft: 6,
                      }}
                    >
                      <div style={{ display: "flex", gap: 14 }}>
                        <div style={{ fontSize: 11.5, color: "#FB923C", fontFamily: "'IBM Plex Mono',monospace" }}>
                          収縮期血圧 (mmHg)
                        </div>
                        <div style={{ fontSize: 11.5, color: "#60A5FA", fontFamily: "'IBM Plex Mono',monospace" }}>
                          拡張期血圧 (mmHg)
                        </div>
                      </div>
                      <div style={{ fontSize: 11, color: "#3F4C63" }}>治療経過時間 (分) ・点＝実測タイミング</div>
                    </div>
                    <ResponsiveContainer width="100%" height={220}>
                      <LineChart data={active.rows} margin={{ top: 4, right: 14, left: -8, bottom: 4 }}>
                        <CartesianGrid stroke="#152036" strokeDasharray="2 4" vertical={false} />
                        <XAxis
                          dataKey="treatTimeMin"
                          tick={{ fill: "#4A5670", fontSize: 10.5 }}
                          tickFormatter={monitorTick}
                          stroke="#1B2536"
                          minTickGap={40}
                        />
                        <YAxis tick={{ fill: "#4A5670", fontSize: 10.5 }} stroke="#1B2536" width={44} />
                        <Tooltip
                          contentStyle={{
                            background: "#0F1826",
                            border: "1px solid #2A3548",
                            borderRadius: 8,
                            fontSize: 12,
                          }}
                          labelFormatter={(v) => `${v} 分`}
                          formatter={(v, name) => [`${v} mmHg`, name === "sysBp" ? "収縮期" : "拡張期"]}
                        />
                        <Line
                          type="stepAfter"
                          dataKey="sysBp"
                          stroke="#FB923C"
                          strokeWidth={1.6}
                          dot={bpDot("#FB923C", "sysBpChanged")}
                          isAnimationActive={false}
                        />
                        <Line
                          type="stepAfter"
                          dataKey="diaBp"
                          stroke="#60A5FA"
                          strokeWidth={1.6}
                          dot={bpDot("#60A5FA", "diaBpChanged")}
                          isAnimationActive={false}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* ΔBV・PRR・除水速度 3変数バブルチャート */}
                {active.hasDbv && active.hasUf && (
                  <div
                    {...dragTargetProps("triple")}
                    style={{
                      order: chartOrder.indexOf("triple"),
                      background: "#0F1826",
                      border: "1px solid #202B3D",
                      borderRadius: 12,
                      padding: "16px 14px",
                      marginBottom: 18,
                    }}
                  >
                    <div
                      {...dragSourceProps("triple")}
                      className="no-print"
                      style={{ display: "flex", alignItems: "center", gap: 6, cursor: "grab", marginBottom: 6 }}
                    >
                      <GripVertical size={13} color="#4A5670" />
                      <span style={{ fontSize: 10, color: "#4A5670" }}>ドラッグで並び替え</span>
                    </div>
                    <div style={{ fontSize: 12, color: "#FFFFFF", marginBottom: 2 }}>
                      ΔBV・PRR瞬時値・除水速度の関係（バブルの大きさ＝除水速度）
                    </div>
                    <div style={{ fontSize: 10.5, color: "#FFFFFF", marginBottom: 8 }}>
                      横軸: ΔBV(%) ／ 縦軸: PRR瞬時値(L/h) ／ 大きい点ほど除水速度が速い
                    </div>
                    <ResponsiveContainer width="100%" height={240}>
                      <ScatterChart margin={{ top: 4, right: 16, left: -6, bottom: 4 }}>
                        <CartesianGrid stroke="#1B2536" strokeDasharray="2 4" />
                        <XAxis
                          type="number"
                          dataKey="x"
                          name="ΔBV(%)"
                          tick={{ fill: "#FFFFFF", fontSize: 10.5 }}
                          stroke="#1B2536"
                          domain={tripleXDomain}
                          allowDataOverflow
                          label={{ value: "ΔBV(%)", position: "insideBottom", fill: "#FFFFFF", fontSize: 11, offset: -2 }}
                        />
                        <YAxis
                          type="number"
                          dataKey="y"
                          name="PRR瞬時値[L/h]"
                          tick={{ fill: "#FFFFFF", fontSize: 10.5 }}
                          stroke="#1B2536"
                          domain={tripleYDomain}
                          allowDataOverflow
                          width={44}
                        />
                        <ZAxis dataKey="z" range={[16, 260]} name="除水速度[L/h]" />
                        <Tooltip
                          cursor={{ strokeDasharray: "3 3" }}
                          contentStyle={{
                            background: "#0F1826",
                            border: "1px solid #2A3548",
                            borderRadius: 8,
                            fontSize: 12,
                          }}
                          formatter={(value, name, props) => {
                            if (!props) return [value, name];
                            if (props.dataKey === "x") return [`${value.toFixed(1)}%`, "ΔBV"];
                            if (props.dataKey === "z") return [`${value.toFixed(2)} L/h`, "除水速度"];
                            return [value.toFixed(3), "PRR瞬時値[L/h]"];
                          }}
                        />
                        <Scatter data={tripleScatterData} fill="#2DD4BF" fillOpacity={0.45} />
                      </ScatterChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* ダウンロード */}
                <div className="no-print" style={{ order: 100, display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button
                    onClick={() => downloadExcel(active.filename, active)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      background: "#0F766E",
                      color: "#E7ECF3",
                      border: "none",
                      borderRadius: 9,
                      padding: "10px 16px",
                      fontSize: 13.5,
                      fontWeight: 500,
                      cursor: "pointer",
                    }}
                  >
                    <Download size={15} />
                    抽出済みデータ(BV+PRR)をExcelでダウンロード
                  </button>
                  <button
                    onClick={() => window.print()}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      background: "#1B2536",
                      color: "#E7ECF3",
                      border: "1px solid #2A3548",
                      borderRadius: 9,
                      padding: "10px 16px",
                      fontSize: 13.5,
                      fontWeight: 500,
                      cursor: "pointer",
                    }}
                  >
                    <Printer size={15} />
                    PDFレポート出力（印刷）
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {results.length > 1 && viewMode === "compare" && (
          <div className="report-print-area" style={{ marginTop: 20 }}>
            <div className="print-only" style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#111827" }}>透析 BV / PRR 分析レポート（比較ビュー）</div>
              <div style={{ fontSize: 12, color: "#374151", marginTop: 4 }}>
                {scopeLabel} ／ 対象 {sheetResults.length} 件 ／ 作成日時: {new Date().toLocaleString("ja-JP")}
              </div>
            </div>

            <ScopeTabs
              presentPatients={presentPatients}
              overallPatient={overallPatient}
              selectPatient={selectPatient}
              presentWeekdays={presentWeekdays}
              overallSheet={overallSheet}
              selectSheet={selectSheet}
            />

            {/* 比較サマリー表 */}
            <div
              style={{
                background: "#0F1826",
                border: "1px solid #202B3D",
                borderRadius: 12,
                padding: "14px 16px",
                marginBottom: 20,
                overflowX: "auto",
              }}
            >
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                <thead>
                  <tr style={{ color: "#647089", textAlign: "left" }}>
                    <th style={{ padding: "6px 10px", fontWeight: 500 }}>ファイル</th>
                    <th style={{ padding: "6px 10px", fontWeight: 500 }}>開始</th>
                    <th style={{ padding: "6px 10px", fontWeight: 500 }}>終了</th>
                    <th style={{ padding: "6px 10px", fontWeight: 500 }}>最大ΔBV低下</th>
                    <th style={{ padding: "6px 10px", fontWeight: 500 }}>PRR積算量合計</th>
                    <th style={{ padding: "6px 10px", fontWeight: 500 }}>ΔBV-PRR相関(r)</th>
                    <th style={{ padding: "6px 10px", fontWeight: 500 }}>総除水量</th>
                    <th style={{ padding: "6px 10px", fontWeight: 500 }}>血圧低下(収縮期)</th>
                  </tr>
                </thead>
                <tbody>
                  {sheetResults.map((r, i) => (
                    <tr key={r.id} style={{ borderTop: "1px solid #1B2536" }}>
                      <td style={{ padding: "8px 10px", display: "flex", alignItems: "center", gap: 8 }}>
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            background: colorFor(i),
                            flexShrink: 0,
                          }}
                        />
                        <span
                          style={{
                            fontFamily: "'IBM Plex Mono',monospace",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            maxWidth: 160,
                          }}
                          title={r.filename}
                        >
                          {r.shortLabel}
                        </span>
                      </td>
                      <td style={{ padding: "8px 10px", fontFamily: "'IBM Plex Mono',monospace" }}>{r.startLabel}</td>
                      <td style={{ padding: "8px 10px", fontFamily: "'IBM Plex Mono',monospace" }}>{r.endLabel}</td>
                      <td style={{ padding: "8px 10px", fontFamily: "'IBM Plex Mono',monospace" }}>
                        {r.hasDbv ? `${r.minDbv.toFixed(1)}% (${r.minDbvTime})` : "-"}
                      </td>
                      <td style={{ padding: "8px 10px", fontFamily: "'IBM Plex Mono',monospace", color: "#5EEAD4" }}>
                        {r.totalPrrVolumeL.toFixed(4)} L
                      </td>
                      <td style={{ padding: "8px 10px", fontFamily: "'IBM Plex Mono',monospace" }}>
                        {r.hasDbv ? corrLabel(r.corrDbvPrr) : "-"}
                      </td>
                      <td style={{ padding: "8px 10px", fontFamily: "'IBM Plex Mono',monospace" }}>
                        {r.hasUf ? `${r.totalUfVolumeL.toFixed(2)} L` : "-"}
                      </td>
                      <td style={{ padding: "8px 10px", fontFamily: "'IBM Plex Mono',monospace" }}>
                        {r.hasBp ? `${r.sysDrop} mmHg (${r.minSysBp}まで)` : "-"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* ΔBV 重ね合わせグラフ */}
            {sheetResults.some((r) => r.hasDbv) && (
              <div
                style={{
                  background: "#050B14",
                  border: "1px solid #1B2536",
                  borderRadius: 12,
                  padding: "18px 14px 6px",
                  marginBottom: 20,
                }}
              >
                <div style={{ fontSize: 12, color: "#F59E0B", marginBottom: 8, paddingLeft: 6 }}>
                  ΔBV(%) 比較（各ファイルの開始からの経過時間で揃えて表示）
                </div>
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart margin={{ top: 4, right: 14, left: -8, bottom: 4 }}>
                    <CartesianGrid stroke="#152036" strokeDasharray="2 4" vertical={false} />
                    <XAxis
                      type="number"
                      dataKey="elapsedMin"
                      tick={{ fill: "#8B9CB3", fontSize: 10.5 }}
                      tickFormatter={monitorTick}
                      stroke="#1B2536"
                      label={{ value: "経過時間 (分)", position: "insideBottom", fill: "#CBD5E1", fontSize: 10, offset: -2 }}
                    />
                    <YAxis tick={{ fill: "#8B9CB3", fontSize: 10.5 }} stroke="#1B2536" width={44} />
                    <ReferenceLine y={0} stroke="#2A3548" />
                    <Legend wrapperStyle={{ fontSize: 11.5, color: "#CBD5E1" }} />
                    <Tooltip
                      contentStyle={{ background: "#0F1826", border: "1px solid #2A3548", borderRadius: 8, fontSize: 12 }}
                      labelFormatter={(v) => `${v} 分`}
                      formatter={(v) => [`${v.toFixed(1)}%`, "ΔBV"]}
                    />
                    {sheetResults
                      .filter((r) => r.hasDbv)
                      .map((r, i) => (
                        <Line
                          key={r.id}
                          data={r.rows}
                          dataKey="dbvPercent"
                          name={r.shortLabel}
                          stroke={colorFor(sheetResults.indexOf(r))}
                          strokeWidth={1.5}
                          dot={false}
                          isAnimationActive={false}
                        />
                      ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {/* PRR 重ね合わせグラフ */}
            <div
              style={{
                background: "#050B14",
                border: "1px solid #1B2536",
                borderRadius: 12,
                padding: "18px 14px 6px",
                marginBottom: 20,
              }}
            >
              <div style={{ fontSize: 12, color: "#5EEAD4", marginBottom: 8, paddingLeft: 6 }}>
                PRR瞬時値[L/h] 比較（各ファイルの開始からの経過時間で揃えて表示）
              </div>
              <ResponsiveContainer width="100%" height={280}>
                <LineChart margin={{ top: 4, right: 14, left: -8, bottom: 4 }}>
                  <CartesianGrid stroke="#152036" strokeDasharray="2 4" vertical={false} />
                  <XAxis
                    type="number"
                    dataKey="elapsedMin"
                    tick={{ fill: "#8B9CB3", fontSize: 10.5 }}
                    tickFormatter={monitorTick}
                    stroke="#1B2536"
                    label={{ value: "経過時間 (分)", position: "insideBottom", fill: "#CBD5E1", fontSize: 10, offset: -2 }}
                  />
                  <YAxis tick={{ fill: "#8B9CB3", fontSize: 10.5 }} stroke="#1B2536" width={44} />
                  <ReferenceLine y={0} stroke="#2A3548" />
                  <Legend wrapperStyle={{ fontSize: 11.5, color: "#CBD5E1" }} />
                  <Tooltip
                    contentStyle={{ background: "#0F1826", border: "1px solid #2A3548", borderRadius: 8, fontSize: 12 }}
                    labelFormatter={(v) => `${v} 分`}
                    formatter={(v) => [v.toFixed(3), "PRR瞬時値[L/h]"]}
                  />
                  {sheetResults.map((r, i) => (
                    <Line
                      key={r.id}
                      data={r.rows}
                      dataKey="prrInstant"
                      name={r.shortLabel}
                      stroke={colorFor(i)}
                      strokeWidth={1.5}
                      dot={false}
                      isAnimationActive={false}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>

            {/* 除水速度 重ね合わせグラフ */}
            {sheetResults.some((r) => r.hasUf) && (
              <div
                style={{
                  background: "#050B14",
                  border: "1px solid #1B2536",
                  borderRadius: 12,
                  padding: "18px 14px 6px",
                  marginBottom: 12,
                }}
              >
                <div style={{ fontSize: 12, color: "#818CF8", marginBottom: 8, paddingLeft: 6 }}>
                  除水速度(L/h) 比較（各ファイルの開始からの経過時間で揃えて表示）
                </div>
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart margin={{ top: 4, right: 14, left: -8, bottom: 4 }}>
                    <CartesianGrid stroke="#152036" strokeDasharray="2 4" vertical={false} />
                    <XAxis
                      type="number"
                      dataKey="elapsedMin"
                      tick={{ fill: "#8B9CB3", fontSize: 10.5 }}
                      tickFormatter={monitorTick}
                      stroke="#1B2536"
                      label={{ value: "経過時間 (分)", position: "insideBottom", fill: "#CBD5E1", fontSize: 10, offset: -2 }}
                    />
                    <YAxis tick={{ fill: "#8B9CB3", fontSize: 10.5 }} stroke="#1B2536" width={44} />
                    <Legend wrapperStyle={{ fontSize: 11.5, color: "#CBD5E1" }} />
                    <Tooltip
                      contentStyle={{ background: "#0F1826", border: "1px solid #2A3548", borderRadius: 8, fontSize: 12 }}
                      labelFormatter={(v) => `${v} 分`}
                      formatter={(v) => [`${v.toFixed(2)} L/h`, "除水速度"]}
                    />
                    {sheetResults
                      .filter((r) => r.hasUf)
                      .map((r) => (
                        <Line
                          key={r.id}
                          data={r.rows}
                          dataKey="ufSpeedLh"
                          name={r.shortLabel}
                          stroke={colorFor(sheetResults.indexOf(r))}
                          strokeWidth={1.5}
                          dot={false}
                          isAnimationActive={false}
                        />
                      ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        )}

        {results.length > 1 && viewMode === "overall" && (
          <div className="report-print-area" style={{ marginTop: 20 }}>
            <div className="print-only" style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "#111827" }}>透析 BV / PRR 分析レポート（総合分析）</div>
              <div style={{ fontSize: 12, color: "#374151", marginTop: 4 }}>
                {scopeLabel} ／ 対象 {sheetResults.length} 件 ／ 作成日時: {new Date().toLocaleString("ja-JP")}
              </div>
            </div>

            <ScopeTabs
              presentPatients={presentPatients}
              overallPatient={overallPatient}
              selectPatient={selectPatient}
              presentWeekdays={presentWeekdays}
              overallSheet={overallSheet}
              selectSheet={selectSheet}
            />

            {/* AI総合分析用プロンプト生成 */}
            <div
              className="no-print"
              style={{
                background: "linear-gradient(135deg, rgba(45,212,191,0.06), rgba(15,118,110,0.03))",
                border: "1px solid rgba(45,212,191,0.3)",
                borderRadius: 12,
                padding: "16px 18px",
                marginBottom: 20,
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 10 }}>
                <div>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: "#5EEAD4", display: "flex", alignItems: "center", gap: 6 }}>
                    <Activity size={15} />
                    AI総合分析用プロンプト生成
                  </div>
                  <div style={{ fontSize: 11.5, color: "#8B9CB3", marginTop: 2 }}>
                    {overallPatient === "all" && overallSheet === "all"
                      ? `読み込んだ${sheetResults.length}件のセッションから、専門的な分析を依頼するプロンプトを自動生成します`
                      : `${scopeLabel}の${sheetResults.length}件のセッションから、専門的な分析を依頼するプロンプトを自動生成します`}
                  </div>
                </div>
                <button
                  onClick={generateAnalysisPrompt}
                  style={{
                    background: "#0F766E",
                    color: "#E7ECF3",
                    border: "none",
                    borderRadius: 9,
                    padding: "9px 16px",
                    fontSize: 12.5,
                    fontWeight: 500,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  {generatedPrompt ? "プロンプトを再生成" : "分析用プロンプトを生成"}
                </button>
              </div>

              {generatedPrompt && (
                <div style={{ marginTop: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <div style={{ fontSize: 11.5, color: "#8B9CB3" }}>
                      このプロンプトをコピーして、ChatGPTやClaudeなどのAIチャットに貼り付けるだけで専門的な詳細分析が得られます
                    </div>
                    <button
                      onClick={copyPrompt}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        background: copyStatus === "copied" ? "#0F766E" : "#1B2536",
                        color: "#E7ECF3",
                        border: "1px solid #2A3548",
                        borderRadius: 8,
                        padding: "6px 12px",
                        fontSize: 12,
                        fontWeight: 500,
                        cursor: "pointer",
                        whiteSpace: "nowrap",
                        flexShrink: 0,
                      }}
                    >
                      {copyStatus === "copied" ? <Check size={13} /> : <Copy size={13} />}
                      {copyStatus === "copied" ? "コピーしました" : "コピーする"}
                    </button>
                  </div>
                  <textarea
                    readOnly
                    value={generatedPrompt}
                    onFocus={(e) => e.target.select()}
                    style={{
                      width: "100%",
                      height: 260,
                      resize: "vertical",
                      background: "#0F1826",
                      border: "1px solid #202B3D",
                      borderRadius: 10,
                      padding: "12px 14px",
                      fontSize: 12,
                      lineHeight: 1.6,
                      color: "#E7ECF3",
                      fontFamily: "'IBM Plex Mono',monospace",
                      boxSizing: "border-box",
                    }}
                  />
                </div>
              )}

              <div style={{ marginTop: 12, fontSize: 10, color: "#4A5670", lineHeight: 1.6 }}>
                ※ 生成されるのはAIへの分析依頼文であり、医学的診断や治療方針の決定ではありません。実際の対応は必ず医療スタッフの判断で行ってください。
              </div>
            </div>

            {(() => {
              const ufSessions = sheetResults.filter((r) => r.hasUf);
              const bpSessions = sheetResults.filter((r) => r.hasBp);
              const dbvSessions = sheetResults.filter((r) => r.hasDbv);
              const corrSessions = dbvSessions.filter((r) => r.corrDbvPrr !== null);

              const avg = (arr) => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);
              const avgUf = avg(ufSessions.map((r) => r.totalUfVolumeL));
              const avgSysDrop = avg(bpSessions.map((r) => r.sysDrop));
              const avgMinDbv = avg(dbvSessions.map((r) => r.minDbv));
              const avgCorr = avg(corrSessions.map((r) => r.corrDbvPrr));

              return (
                <>
                  {/* 全体サマリー */}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))",
                      gap: 10,
                      marginBottom: 20,
                    }}
                  >
                    {[
                      [
                        overallPatient === "all" && overallSheet === "all"
                          ? "読み込みセッション数"
                          : `${scopeLabel}のセッション数`,
                        `${sheetResults.length} 件`,
                      ],
                      ...(avgUf !== null ? [["平均総除水量", `${avgUf.toFixed(2)} L`]] : []),
                      ...(avgSysDrop !== null ? [["平均血圧低下(収縮期)", `${avgSysDrop.toFixed(1)} mmHg`]] : []),
                      ...(avgMinDbv !== null ? [["平均最大ΔBV低下", `${avgMinDbv.toFixed(1)}%`]] : []),
                      ...(avgCorr !== null ? [["平均ΔBV-PRR相関(r)", avgCorr.toFixed(2)]] : []),
                    ].map(([label, value]) => (
                      <div
                        key={label}
                        style={{
                          background: "#0F1826",
                          border: "1px solid #202B3D",
                          borderRadius: 10,
                          padding: "10px 12px",
                        }}
                      >
                        <div style={{ fontSize: 10.5, color: "#647089", marginBottom: 4 }}>{label}</div>
                        <div
                          style={{
                            fontSize: 14.5,
                            fontFamily: "'IBM Plex Mono',monospace",
                            fontWeight: 500,
                            color: "#E7ECF3",
                          }}
                        >
                          {value}
                        </div>
                      </div>
                    ))}
                  </div>

                  <div style={{ fontSize: 11.5, color: "#647089", marginBottom: 12 }}>
                    セッションはファイル名から読み取った実施日時の順に並べています(日時が読み取れないファイルは末尾)
                  </div>

                  {/* セッション毎の推移（小さいグラフを並べる） */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))", gap: 16 }}>
                    {/* PRR積算量合計の推移 */}
                    <div
                      style={{
                        background: "#050B14",
                        border: "1px solid #1B2536",
                        borderRadius: 12,
                        padding: "14px 12px 6px",
                      }}
                    >
                      <div style={{ fontSize: 11.5, color: "#5EEAD4", marginBottom: 6, paddingLeft: 4 }}>
                        PRR積算量合計(L)の推移
                      </div>
                      <ResponsiveContainer width="100%" height={180}>
                        <BarChart data={sheetResults} margin={{ top: 4, right: 10, left: -18, bottom: 4 }}>
                          <CartesianGrid stroke="#152036" strokeDasharray="2 4" vertical={false} />
                          <XAxis dataKey="shortLabel" tick={{ fill: "#8B9CB3", fontSize: 9.5 }} stroke="#1B2536" />
                          <YAxis tick={{ fill: "#8B9CB3", fontSize: 10 }} stroke="#1B2536" width={40} />
                          <Tooltip
                            contentStyle={{ background: "#0F1826", border: "1px solid #2A3548", borderRadius: 8, fontSize: 12 }}
                            formatter={(v) => [`${v.toFixed(4)} L`, "PRR積算量合計"]}
                          />
                          <Bar dataKey="totalPrrVolumeL" fill="#2DD4BF" radius={[3, 3, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>

                    {/* 最大ΔBV低下の推移 */}
                    {dbvSessions.length > 0 && (
                      <div
                        style={{
                          background: "#050B14",
                          border: "1px solid #1B2536",
                          borderRadius: 12,
                          padding: "14px 12px 6px",
                        }}
                      >
                        <div style={{ fontSize: 11.5, color: "#F59E0B", marginBottom: 6, paddingLeft: 4 }}>
                          最大ΔBV低下(%)の推移
                        </div>
                        <ResponsiveContainer width="100%" height={180}>
                          <BarChart data={dbvSessions} margin={{ top: 4, right: 10, left: -18, bottom: 4 }}>
                            <CartesianGrid stroke="#152036" strokeDasharray="2 4" vertical={false} />
                            <XAxis dataKey="shortLabel" tick={{ fill: "#8B9CB3", fontSize: 9.5 }} stroke="#1B2536" />
                            <YAxis tick={{ fill: "#8B9CB3", fontSize: 10 }} stroke="#1B2536" width={40} />
                            <Tooltip
                              contentStyle={{ background: "#0F1826", border: "1px solid #2A3548", borderRadius: 8, fontSize: 12 }}
                              formatter={(v) => [`${v.toFixed(1)}%`, "最大ΔBV低下"]}
                            />
                            <Bar dataKey="minDbv" fill="#F59E0B" radius={[3, 3, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    )}

                    {/* 血圧低下量の推移 */}
                    {bpSessions.length > 0 && (
                      <div
                        style={{
                          background: "#050B14",
                          border: "1px solid #1B2536",
                          borderRadius: 12,
                          padding: "14px 12px 6px",
                        }}
                      >
                        <div style={{ fontSize: 11.5, color: "#FB923C", marginBottom: 6, paddingLeft: 4 }}>
                          血圧低下量(収縮期・mmHg)の推移
                        </div>
                        <ResponsiveContainer width="100%" height={180}>
                          <BarChart data={bpSessions} margin={{ top: 4, right: 10, left: -18, bottom: 4 }}>
                            <CartesianGrid stroke="#152036" strokeDasharray="2 4" vertical={false} />
                            <XAxis dataKey="shortLabel" tick={{ fill: "#8B9CB3", fontSize: 9.5 }} stroke="#1B2536" />
                            <YAxis tick={{ fill: "#8B9CB3", fontSize: 10 }} stroke="#1B2536" width={40} />
                            <Tooltip
                              contentStyle={{ background: "#0F1826", border: "1px solid #2A3548", borderRadius: 8, fontSize: 12 }}
                              formatter={(v) => [`${v} mmHg`, "血圧低下量"]}
                            />
                            <Bar dataKey="sysDrop" fill="#FB923C" radius={[3, 3, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    )}

                    {/* 総除水量の推移 */}
                    {ufSessions.length > 0 && (
                      <div
                        style={{
                          background: "#050B14",
                          border: "1px solid #1B2536",
                          borderRadius: 12,
                          padding: "14px 12px 6px",
                        }}
                      >
                        <div style={{ fontSize: 11.5, color: "#F472B6", marginBottom: 6, paddingLeft: 4 }}>
                          総除水量(L)の推移
                        </div>
                        <ResponsiveContainer width="100%" height={180}>
                          <BarChart data={ufSessions} margin={{ top: 4, right: 10, left: -18, bottom: 4 }}>
                            <CartesianGrid stroke="#152036" strokeDasharray="2 4" vertical={false} />
                            <XAxis dataKey="shortLabel" tick={{ fill: "#8B9CB3", fontSize: 9.5 }} stroke="#1B2536" />
                            <YAxis tick={{ fill: "#8B9CB3", fontSize: 10 }} stroke="#1B2536" width={40} />
                            <Tooltip
                              contentStyle={{ background: "#0F1826", border: "1px solid #2A3548", borderRadius: 8, fontSize: 12 }}
                              formatter={(v) => [`${v.toFixed(2)} L`, "総除水量"]}
                            />
                            <Bar dataKey="totalUfVolumeL" fill="#F472B6" radius={[3, 3, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </div>
                    )}
                  </div>
                </>
              );
            })()}
          </div>
        )}

        {results.length === 0 && !isProcessing && (
          <div style={{ marginTop: 40, fontSize: 12.5, color: "#4A5670", lineHeight: 1.8 }}>
            <div
              style={{
                fontSize: 11.5,
                color: "#647089",
                marginBottom: 6,
                letterSpacing: 0.5,
                textTransform: "uppercase",
              }}
            >
              処理ロジック
            </div>
            1. PRR[L/h]*100 列から -9999（無効値）を除外し、有効な治療区間を自動抽出（スライダーで手動調整も可能）
            <br />
            2. 同じ行範囲について dBV[%]*10（/10して%）、除水速度・除水量（/100してL/h・L）、収縮期/拡張期血圧を取得
            <br />
            3. PRR瞬時値[L/h]・PRR積算量合計[L]・ΔBV(%)・除水速度/量・血圧の推移をグラフ化
            <br />
            4. ΔBVとPRR、ΔBVと血圧、除水速度とPRRの相関係数を算出
            <br />
            5. 列が見つからない場合はその分析のみスキップし、他の分析は継続します
          </div>
        )}
      </div>
    </div>
  );
}
