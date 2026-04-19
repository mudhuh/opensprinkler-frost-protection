// ============================================================
// OpenSprinkler Frost Protection & Lawn Irrigation System
// Google Apps Script — controls OpenSprinkler via Cloud API
// Weather data from Ecowitt API v3
// Alerts via Twilio (WhatsApp + SMS) and/or SMSAPI.pl
// ============================================================

// === CONFIGURATION — Frost thresholds and timings ===
const FROST_THRESHOLD_ALERT = 1;       // Ground temp (C) to flag as "FROST" in spreadsheet
const FROST_THRESHOLD_TREND = 3;       // Ground temp (C) for trend analysis and intensive logging
const FROST_TREND_DROP_DEGREES = 1.5;  // Min temp drop (C) over trend window to trigger alert
const FROST_TREND_LOOKBACK_RECORDS = 10; // How many recent records to analyze for trend
const FROST_TREND_MIN_RECORDS = 3;     // Min records needed for trend analysis (3 x 15min = 45min)

// === Automatic frost loop thresholds ===
const FROST_LOOP_START_THRESHOLD = 2;          // Ground temp (C) below which loop MAY start (if falling trend)
const FROST_LOOP_ABSOLUTE_START_THRESHOLD = 0.5; // Ground temp (C) below which loop ALWAYS starts
const FROST_LOOP_STOP_THRESHOLD = 3;           // Ground temp (C) above which loop STOPS

// === Frost zone pairs ===
// Zones run in pairs (water pressure too low for 3+ simultaneously).
// Customize these to match your vineyard layout.
const FROST_PAIRS = [[1, 2], [3, 4], [5, 6]];
const FROST_PAIR_DURATION_SECONDS = 180;  // 3 minutes per pair
const FROST_PAIR_GAP_SECONDS = 15;        // Gap between pairs
// Full cycle: 3 pairs x (180s + 15s) ~ 10 min. Recheck after last pair finishes.
const FROST_LOOP_RECHECK_AFTER_LAST_PAIR_SECONDS = 240; // 4 min after last pair start

// === Data validation thresholds ===
const MIN_REASONABLE_GROUND_TEMP = -20; // Min reasonable ground temp (C)
const MAX_REASONABLE_GROUND_TEMP = 50;  // Max reasonable ground temp (C)
const DATA_ERROR_ALERT_COOLDOWN_HOURS = 6;

// === Wind logging ===
const HIGH_GUST_THRESHOLD_MS = 18; // Strong gust threshold (m/s) for immediate logging

// === Powdery mildew risk ===
const POWDERY_MILDEW_HUMIDITY_THRESHOLD = 85; // % humidity
const POWDERY_MILDEW_TEMP_THRESHOLD = 5;      // Temp (C)
const POWDERY_MILDEW_ALERT_COOLDOWN_HOURS = 12;

// === Unit conversion ===
const PRESSURE_CONVERSION_FACTOR = 33.8639; // inHg to hPa

// === Sprinkler stats ===
const FLIPPERS_PER_ZONE = 24;       // Sprinkler heads per zone (adjust to your setup)
const FLIPPER_FLOW_RATE_LPH = 43;   // Flow rate per head in liters/hour

// === Operation mode: "frost" or "lawn" ===
// Switch via: switchToLawnMode() / switchToFrostMode() or web API
const LAWN_ZONES = [5, 6, 8, 9, 10, 12];    // Lawn zone numbers (adjust to your setup)
const LAWN_DURATION_MINUTES = 20;             // Watering time per lawn zone
const LAWN_START_HOUR = 1;                    // Daily lawn watering start hour (1:00 AM)
const LAWN_START_MINUTE = 0;

// === API Keys from Script Properties ===
const APPLICATION_KEY = PropertiesService.getScriptProperties().getProperty("ECOWITT_APPLICATION_KEY");
const API_KEY = PropertiesService.getScriptProperties().getProperty("ECOWITT_API_KEY");
const MAC = PropertiesService.getScriptProperties().getProperty("ECOWITT_MAC");

// === OpenSprinkler credentials ===
const OPENSPRINKLER_OTC = PropertiesService.getScriptProperties().getProperty("OPENSPRINKLER_OTC");
const OPENSPRINKLER_PASSWORD = PropertiesService.getScriptProperties().getProperty("OPENSPRINKLER_PASSWORD");
const OPENSPRINKLER_ZONES = [1, 2, 3, 4, 5, 6]; // Zones to include in daily summary logging

// === Panel auth token ===
const PANEL_SECRET = PropertiesService.getScriptProperties().getProperty("PANEL_SECRET");


// ============================================================
// UTILITY FUNCTIONS
// ============================================================

// MD5 hash helper (required by OpenSprinkler API)
function calculateMD5(input) {
  if (!input) return null;
  const rawDigest = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, input, Utilities.Charset.UTF_8);
  let md5 = '';
  for (let i = 0; i < rawDigest.length; i++) {
    let _byte = rawDigest[i];
    if (_byte < 0) _byte += 256;
    const hex = _byte.toString(16);
    if (hex.length === 1) md5 += '0';
    md5 += hex;
  }
  return md5;
}


// ============================================================
// WEATHER DATA (Ecowitt API)
// ============================================================

// Fetch real-time weather data from Ecowitt Cloud API
function fetchWeatherData() {
  if (!APPLICATION_KEY || !API_KEY || !MAC) {
    Logger.log("Error: Missing Ecowitt API keys or MAC address in Script Properties.");
    return null;
  }
  const url = `https://api.ecowitt.net/api/v3/device/real_time?application_key=${APPLICATION_KEY}&api_key=${API_KEY}&mac=${MAC}&call_back=all`;
  Logger.log(`Fetching weather data (MAC: ${MAC})...`);
  try {
    const options = { muteHttpExceptions: true, readTimeoutMillis: 30000 };
    const response = UrlFetchApp.fetch(url, options);
    const responseCode = response.getResponseCode();
    if (responseCode !== 200) { Logger.log(`HTTP error ${responseCode} from Ecowitt API.`); return null; }
    const json = JSON.parse(response.getContentText());
    if (json && json.code !== 0) { Logger.log(`Ecowitt API error: code ${json.code}.`); return null; }
    return json.data;
  } catch (e) {
    if (e.message.includes("Timeout")) { Logger.log("Ecowitt API timeout."); }
    else { Logger.log("Critical error in fetchWeatherData: " + e); }
    return null;
  }
}

// Fetch sprinkler run logs from OpenSprinkler
function fetchSprinklerLogData(daysAgo) {
  const plainPassword = OPENSPRINKLER_PASSWORD;
  if (!plainPassword || !OPENSPRINKLER_OTC) { Logger.log("Error: Missing OS password or OTC."); return null; }
  const hashedPassword = calculateMD5(plainPassword);
  if (!hashedPassword) { Logger.log("Error: MD5 hash failed."); return null; }
  const url = `https://cloud.openthings.io/forward/v1/${OPENSPRINKLER_OTC}/jl?pw=${hashedPassword}&hist=${daysAgo}`;
  Logger.log(`Fetching OS logs for past ${daysAgo} days...`);
  try {
    const options = { muteHttpExceptions: true, readTimeoutMillis: 45000 };
    const response = UrlFetchApp.fetch(url, options);
    if (response.getResponseCode() !== 200) { Logger.log(`HTTP error ${response.getResponseCode()} fetching OS logs.`); return null; }
    const logs = JSON.parse(response.getContentText());
    Logger.log(`Retrieved ${logs ? logs.length : 0} OS log entries.`);
    return logs;
  } catch (e) {
    Logger.log("Error in fetchSprinklerLogData: " + e);
    return null;
  }
}


// ============================================================
// WEB APP API (doGet / doPost)
// ============================================================

// Handle GET requests (web app endpoint)
function doGet(e) {
  const params = e ? e.parameter : {};
  const action = params.action || 'status';
  const token = params.token || '';

  // irrigateVineyard: water the vineyard in pairs (no frost check)
  // Params: minutes=10 (per pair, default 10 min)
  if (action === 'irrigateVineyard') {
    const minutesPerPair = parseInt(params.minutes || '10', 10);
    const totalMinutes = minutesPerPair * FROST_PAIRS.length;
    const props = PropertiesService.getScriptProperties();
    // Stop any existing irrigation
    ScriptApp.getProjectTriggers().forEach(t => {
      if (t.getHandlerFunction() === 'irrigateNextPairTrigger') ScriptApp.deleteTrigger(t);
    });
    props.setProperty('IRRIGATE_PAIR_INDEX', '0');
    props.setProperty('IRRIGATE_PAIR_DURATION_SECONDS', String(minutesPerPair * 60));
    props.setProperty('IRRIGATE_ACTIVE', 'true');
    props.setProperty('IRRIGATE_CYCLE', '1');
    props.setProperty('IRRIGATE_CURRENT_PAIR', JSON.stringify(FROST_PAIRS[0]));
    props.setProperty('IRRIGATE_PAIR_START_TIME', new Date().toISOString());
    props.setProperty('IRRIGATE_TOTAL_PAIRS', String(FROST_PAIRS.length));
    // Start first pair
    const pw = calculateMD5(OPENSPRINKLER_PASSWORD);
    const pair = FROST_PAIRS[0];
    const results = [];
    for (const zone of pair) {
      const sid = zone - 1;
      const url = `https://cloud.openthings.io/forward/v1/${OPENSPRINKLER_OTC}/cm?pw=${pw}&sid=${sid}&en=1&t=${minutesPerPair * 60}`;
      try {
        const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, readTimeoutMillis: 15000 });
        results.push({ zone: zone, response: resp.getContentText() });
      } catch (e) {
        results.push({ zone: zone, error: e.toString() });
      }
    }
    // Schedule next pair
    if (FROST_PAIRS.length > 1) {
      props.setProperty('IRRIGATE_PAIR_INDEX', '1');
      ScriptApp.newTrigger('irrigateNextPairTrigger')
        .timeBased()
        .after((minutesPerPair * 60 + 15) * 1000)
        .create();
    }
    return ContentService.createTextOutput(JSON.stringify({
      ok: true,
      message: `Vineyard irrigation: ${FROST_PAIRS.length} pairs x ${minutesPerPair} min (total ${totalMinutes} min). Started: S${pair.join('+S')}.`,
      pairs: FROST_PAIRS, minutesPerPair: minutesPerPair, totalMinutes: totalMinutes, firstPair: results
    })).setMimeType(ContentService.MimeType.JSON);
  }

  // stopIrrigate: stop vineyard irrigation
  if (action === 'stopIrrigate') {
    ScriptApp.getProjectTriggers().forEach(t => {
      if (t.getHandlerFunction() === 'irrigateNextPairTrigger') ScriptApp.deleteTrigger(t);
    });
    PropertiesService.getScriptProperties().setProperty('IRRIGATE_ACTIVE', 'false');
    const pw = calculateMD5(OPENSPRINKLER_PASSWORD);
    for (const pair of FROST_PAIRS) {
      for (const zone of pair) {
        const sid = zone - 1;
        try {
          UrlFetchApp.fetch(`https://cloud.openthings.io/forward/v1/${OPENSPRINKLER_OTC}/cm?pw=${pw}&sid=${sid}&en=0&t=0`, { muteHttpExceptions: true, readTimeoutMillis: 10000 });
        } catch (e) {}
      }
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: true, message: 'Irrigation stopped.' })).setMimeType(ContentService.MimeType.JSON);
  }

  // runZones: manually run specific zones (no auth required — for testing)
  // Params: zones=1,2,3 duration=60
  if (action === 'runZones') {
    const zoneList = (params.zones || '').split(',').map(Number).filter(n => n > 0);
    const duration = parseInt(params.duration || '60', 10);
    if (zoneList.length === 0) {
      return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'No zones specified (zones=1,2,3)' })).setMimeType(ContentService.MimeType.JSON);
    }
    const pw = calculateMD5(OPENSPRINKLER_PASSWORD);
    const results = [];
    for (const zone of zoneList) {
      const sid = zone - 1;
      const url = `https://cloud.openthings.io/forward/v1/${OPENSPRINKLER_OTC}/cm?pw=${pw}&sid=${sid}&en=1&t=${duration}`;
      try {
        const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, readTimeoutMillis: 15000 });
        results.push({ zone: zone, sid: sid, status: resp.getResponseCode(), response: resp.getContentText() });
      } catch (e) {
        results.push({ zone: zone, sid: sid, error: e.toString() });
      }
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: true, duration: duration, results: results })).setMimeType(ContentService.MimeType.JSON);
  }

  // programs: list OpenSprinkler programs (no auth required)
  if (action === 'programs') {
    const result = { ok: true, programs: [] };
    try {
      const pw = calculateMD5(OPENSPRINKLER_PASSWORD);
      if (pw && OPENSPRINKLER_OTC) {
        const url = `https://cloud.openthings.io/forward/v1/${OPENSPRINKLER_OTC}/jp?pw=${pw}`;
        const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, readTimeoutMillis: 30000 });
        if (resp.getResponseCode() === 200) {
          const data = JSON.parse(resp.getContentText());
          if (data && data.pd && Array.isArray(data.pd)) {
            for (let i = 0; i < data.pd.length; i++) {
              const p = data.pd[i];
              if (!p || p.length < 6) continue;
              const name = String(p[5]).trim();
              const durations = p[4] || [];
              const zones = [];
              for (let z = 0; z < durations.length; z++) {
                if (durations[z] > 0) {
                  zones.push({ sid: z + 1, seconds: durations[z], minutes: Math.round(durations[z] / 60 * 10) / 10 });
                }
              }
              result.programs.push({ pid: i, name: name, enabled: !!(p[0] & 1), zones: zones });
            }
          }
          // Add station names
          const jsUrl = `https://cloud.openthings.io/forward/v1/${OPENSPRINKLER_OTC}/js?pw=${pw}`;
          const jsResp = UrlFetchApp.fetch(jsUrl, { muteHttpExceptions: true, readTimeoutMillis: 15000 });
          if (jsResp.getResponseCode() === 200) {
            const jsData = JSON.parse(jsResp.getContentText());
            result.stationNames = jsData.snames || [];
          }
        }
      }
    } catch (e) {
      result.error = e.toString();
    }
    return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
  }

  // status: system status (no auth required)
  if (action === 'status') {
    const mode = getCurrentMode();
    const loopActive = PropertiesService.getScriptProperties().getProperty('FROST_LOOP_ACTIVE') === 'true';
    const props = PropertiesService.getScriptProperties();
    const seasonOverride = props.getProperty('FROST_SEASON_MANUAL_OVERRIDE') === 'true';
    const irrigateActive = props.getProperty('IRRIGATE_ACTIVE') === 'true';
    const statusObj = {
      ok: true, mode: mode, frostLoopActive: loopActive,
      frostSeasonOverride: seasonOverride,
      frostPairs: FROST_PAIRS,
      lawnZones: LAWN_ZONES, lawnDuration: LAWN_DURATION_MINUTES,
      lawnStartHour: LAWN_START_HOUR, timestamp: new Date().toISOString(),
      activeZones: [],
      irrigate: irrigateActive ? {
        active: true,
        currentPair: JSON.parse(props.getProperty('IRRIGATE_CURRENT_PAIR') || '[]'),
        pairIndex: parseInt(props.getProperty('IRRIGATE_PAIR_INDEX') || '0', 10),
        totalPairs: parseInt(props.getProperty('IRRIGATE_TOTAL_PAIRS') || '3', 10),
        pairDurationSeconds: parseInt(props.getProperty('IRRIGATE_PAIR_DURATION_SECONDS') || '0', 10),
        pairStartTime: props.getProperty('IRRIGATE_PAIR_START_TIME') || null,
        cycle: parseInt(props.getProperty('IRRIGATE_CYCLE') || '1', 10)
      } : { active: false }
    };
    // Get zone status from OpenSprinkler
    try {
      const pw = calculateMD5(OPENSPRINKLER_PASSWORD);
      if (pw && OPENSPRINKLER_OTC) {
        const osUrl = `https://cloud.openthings.io/forward/v1/${OPENSPRINKLER_OTC}/js?pw=${pw}`;
        const osResp = UrlFetchApp.fetch(osUrl, { muteHttpExceptions: true, readTimeoutMillis: 15000 });
        if (osResp.getResponseCode() === 200) {
          const osData = JSON.parse(osResp.getContentText());
          const sn = osData.sn || { sn: [] };
          const stations = sn.sn || [];
          const names = osData.snames || [];
          const active = [];
          for (let i = 0; i < stations.length; i++) {
            if (stations[i] === 1) {
              active.push({ sid: i + 1, name: names[i] || ('S' + String(i + 1).padStart(2, '0')) });
            }
          }
          statusObj.activeZones = active;
          statusObj.totalZones = stations.length;
        }
      }
    } catch (e) {
      Logger.log('Status OS error: ' + e);
    }
    return ContentService.createTextOutput(JSON.stringify(statusObj)).setMimeType(ContentService.MimeType.JSON);
  }

  // All other actions require authentication
  if (!PANEL_SECRET || token !== PANEL_SECRET) {
    return ContentService.createTextOutput(JSON.stringify({
      ok: false, error: 'Invalid token'
    })).setMimeType(ContentService.MimeType.JSON);
  }

  let result = { ok: true, message: '' };
  switch (action) {
    case 'switchToLawn':
      switchToLawnMode();
      result.message = `LAWN mode active. Zones: ${LAWN_ZONES.join(', ')}, ${LAWN_DURATION_MINUTES} min each, daily at ${LAWN_START_HOUR}:00.`;
      break;
    case 'switchToFrost':
      switchToFrostMode();
      result.message = 'FROST mode active.';
      break;
    case 'testLawn':
      runLawnWatering();
      result.message = 'Started test lawn watering.';
      break;
    case 'stopLawn':
      removeLawnTriggers();
      result.message = 'Lawn watering stopped.';
      break;
    case 'stopAll':
      stopFrostProtection();
      result.message = 'All operations stopped.';
      break;
    case 'startFrostLoop':
      testForceFrostLoopStart();
      result.message = 'Frost loop started (pairs of 2 zones).';
      break;
    case 'enableFrostSeason':
      PropertiesService.getScriptProperties().setProperty('FROST_SEASON_MANUAL_OVERRIDE', 'true');
      result.message = 'Frost season ACTIVE (manual override).';
      break;
    case 'disableFrostSeason':
      PropertiesService.getScriptProperties().deleteProperty('FROST_SEASON_MANUAL_OVERRIDE');
      result.message = 'Frost season follows calendar (override disabled).';
      break;
    default:
      result = { ok: false, error: 'Unknown action: ' + action };
  }
  result.mode = getCurrentMode();
  return ContentService.createTextOutput(JSON.stringify(result)).setMimeType(ContentService.MimeType.JSON);
}

// Handle POST requests
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput(JSON.stringify({ success: false, message: "No POST data." })).setMimeType(ContentService.MimeType.JSON);
    }
    const payload = JSON.parse(e.postData.contents);
    if (!PANEL_SECRET || payload.token !== PANEL_SECRET) {
      Logger.log("doPost rejected - invalid token.");
      return ContentService.createTextOutput(JSON.stringify({ success: false, message: "Invalid token." })).setMimeType(ContentService.MimeType.JSON);
    }

    Logger.log(`doPost action: ${payload.action}`);
    let responseMessage = "Unknown action.";
    let success = false;

    switch (payload.action) {
      case 'stopLoop':
        stopFrostProtection();
        responseMessage = "Frost loop stopped, all OS operations reset.";
        success = true;
        break;
      case 'startLoopManually':
        testForceFrostLoopStart();
        responseMessage = "Frost loop started manually. Check logs.";
        success = true;
        break;
      case 'switchToLawn':
        switchToLawnMode();
        responseMessage = `Switched to LAWN mode. Zones: ${LAWN_ZONES.join(', ')}, ${LAWN_DURATION_MINUTES} min each, daily at ${LAWN_START_HOUR}:00.`;
        success = true;
        break;
      case 'switchToFrost':
        switchToFrostMode();
        responseMessage = "Switched to FROST mode.";
        success = true;
        break;
      case 'getMode':
        const mode = getCurrentMode();
        const loopActive = PropertiesService.getScriptProperties().getProperty('FROST_LOOP_ACTIVE');
        responseMessage = JSON.stringify({ mode: mode, frostLoopActive: loopActive === 'true' });
        success = true;
        break;
      case 'testLawn':
        runLawnWatering();
        responseMessage = "Started test lawn watering.";
        success = true;
        break;
      case 'stopLawn':
        removeLawnTriggers();
        responseMessage = "Lawn watering stopped.";
        success = true;
        break;
    }
    return ContentService.createTextOutput(JSON.stringify({ success: success, message: responseMessage })).setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    Logger.log("Critical error in doPost: " + err.toString());
    return ContentService.createTextOutput(JSON.stringify({ success: false, message: "Error: " + err.toString() })).setMimeType(ContentService.MimeType.JSON);
  }
}


// ============================================================
// WEATHER DATA LOGGING (to Google Sheets)
// ============================================================

// Intensive frost risk logging (called by auto-trigger during risk periods)
function logFrostRiskIntensive() {
  Logger.log("Running logFrostRiskIntensive...");
  const weatherData = fetchWeatherData();
  if (weatherData) {
    logFrostRisk(weatherData);
    predictFrostTrend();
  } else {
    Logger.log("logFrostRiskIntensive: Failed to fetch weather data, skipping.");
  }
}

// Log vineyard outdoor temperature and humidity
function logVineyardTempHumidity(weatherData) {
  if (!weatherData || !weatherData.outdoor) {
    Logger.log("logVineyardTempHumidity: No 'outdoor' data available.");
    return;
  }
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("vineyard_temp_humidity");
  if (!sheet) { Logger.log("Error: Sheet 'vineyard_temp_humidity' not found."); return; }
  const now = new Date();
  // Ecowitt returns Fahrenheit — convert to Celsius
  const tempC = Math.round(((parseFloat(weatherData.outdoor.temperature?.value ?? "NaN") - 32) * 5 / 9) * 10) / 10;
  const humidity = parseFloat(weatherData.outdoor.humidity?.value ?? "NaN");
  const precip = parseFloat(weatherData.rainfall?.daily?.value ?? 0);
  sheet.appendRow([now, tempC, humidity, precip, "Ecowitt API"]);
  Logger.log(`Logged vineyard data: ${now}, ${tempC}C, ${humidity}%, ${precip}mm`);
}

// Log powdery mildew risk based on vineyard data
function logPowderyMildewRisk() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sourceSheet = ss.getSheetByName("vineyard_temp_humidity");
  const riskSheet = ss.getSheetByName("powdery_mildew_risk");
  if (!sourceSheet || !riskSheet) { Logger.log("Error: Missing source or risk sheet for powdery mildew."); return; }

  const data = sourceSheet.getDataRange().getValues();
  const today = new Date();
  const year = today.getFullYear();
  // Season check: June 1 to October 15 (months are 0-indexed in JS)
  if (today < new Date(year, 5, 1) || today > new Date(year, 9, 15)) {
    Logger.log("logPowderyMildewRisk: Outside mildew risk season. Skipping.");
    return;
  }

  const lastRowRisk = riskSheet.getLastRow();
  const existingTimes = lastRowRisk > 0 ? riskSheet.getRange(1, 1, lastRowRisk, 1).getValues().flat().map(t => new Date(t).getTime()) : [];
  const alerts = [];
  let newRowsAdded = 0;

  for (let i = 1; i < data.length; i++) {
    const [time, temp, humidity, precipValue, sourceValue] = data[i];
    if (!time || temp === undefined || humidity === undefined) continue;

    const recordDate = new Date(time);
    if (isNaN(recordDate.getTime())) continue;

    const ts = recordDate.getTime();
    if (!existingTimes.includes(ts)) {
      const risk = humidity > POWDERY_MILDEW_HUMIDITY_THRESHOLD && temp > POWDERY_MILDEW_TEMP_THRESHOLD ? "YES" : "NO";
      riskSheet.appendRow([recordDate, temp, humidity, precipValue, sourceValue, risk]);
      newRowsAdded++;
      existingTimes.push(ts);
      if (risk === "YES") {
        alerts.push(`Humidity: ${humidity}%, temp: ${temp}C (${recordDate.toLocaleString()})`);
      }
    }
  }
  Logger.log(`logPowderyMildewRisk: Added ${newRowsAdded} new risk entries.`);

  if (alerts.length > 0) {
    const alertKey = 'LAST_POWDERY_MILDEW_ALERT_TIME';
    const lastAlertTime = PropertiesService.getScriptProperties().getProperty(alertKey);
    const nowMillis = new Date().getTime();

    if (!lastAlertTime || (nowMillis - parseInt(lastAlertTime, 10)) > POWDERY_MILDEW_ALERT_COOLDOWN_HOURS * 60 * 60 * 1000) {
      sendNotification(`Warning: Powdery mildew risk (${alerts.length} new cases):\n${alerts.slice(-5).join("\n")}`);
      PropertiesService.getScriptProperties().setProperty(alertKey, nowMillis.toString());
      Logger.log(`Sent powdery mildew alert. New cases: ${alerts.length}.`);
    } else {
      Logger.log(`Powdery mildew risk detected (${alerts.length} new cases), but alert is on cooldown.`);
    }
  }
}

// Log solar radiation and UV index
function logSolarUV(weatherData) {
  const hour = new Date().getHours();
  if (hour < 5 || hour > 21) return;
  if (!weatherData || !weatherData.solar_and_uvi) { Logger.log("logSolarUV: No solar/UV data."); return; }
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("solar_uv");
  if (!sheet) { Logger.log("Error: Sheet 'solar_uv' not found."); return; }
  const uv = parseFloat(weatherData.solar_and_uvi.uvi?.value ?? "NaN");
  const radiation = parseFloat(weatherData.solar_and_uvi.solar?.value ?? "NaN");
  sheet.appendRow([new Date(), uv, radiation]);
  Logger.log(`Logged Solar/UV: UV: ${uv}, Radiation: ${radiation}`);
}

// Log rainfall data (smart logging — avoids excessive zero entries)
function logRainfall(weatherData) {
  if (!weatherData || !weatherData.rainfall) {
    Logger.log("logRainfall: No rainfall data available.");
    return;
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("rainfall");
  if (!sheet) { Logger.log("Error: Sheet 'rainfall' not found."); return; }

  const now = new Date();
  const rate = parseFloat(weatherData.rainfall.rain_rate?.value ?? 0);
  const daily = parseFloat(weatherData.rainfall.daily?.value ?? 0);
  const weekly = parseFloat(weatherData.rainfall.weekly?.value ?? 0);
  const monthly = parseFloat(weatherData.rainfall.monthly?.value ?? 0);
  const yearly = parseFloat(weatherData.rainfall.yearly?.value ?? 0);

  const props = PropertiesService.getScriptProperties();
  const todayDateString = Utilities.formatDate(now, Session.getScriptTimeZone(), "yyyy-MM-dd");
  const LAST_DAILY_ZERO_RAIN_LOG_PROP_KEY = 'LAST_DAILY_ZERO_RAIN_LOG_DATE_' + (MAC || 'DEFAULT');

  if (rate > 0) {
    // Currently raining
    sheet.appendRow([now, rate, daily, weekly, monthly, yearly]);
    Logger.log(`Logged rainfall (rate > 0): Rate: ${rate} mm/h, Daily: ${daily} mm`);
  } else {
    if (daily == 0) {
      // No rain today at all — log once per day
      const lastZeroLogDate = props.getProperty(LAST_DAILY_ZERO_RAIN_LOG_PROP_KEY);
      if (lastZeroLogDate !== todayDateString) {
        sheet.appendRow([now, 0, 0, weekly, monthly, yearly]);
        props.setProperty(LAST_DAILY_ZERO_RAIN_LOG_PROP_KEY, todayDateString);
        Logger.log(`Logged single "no rain today" entry for ${todayDateString}.`);
      }
    }
  }
}

// Log wind data (hybrid: daily summary + anomaly logging for strong gusts)
function logWind(weatherData) {
  if (!weatherData || !weatherData.wind) {
    Logger.log("logWind: No wind data available.");
    return;
  }

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("wind");
  if (!sheet) { Logger.log("Error: Sheet 'wind' not found."); return; }

  const now = new Date();
  const todayDateString = Utilities.formatDate(now, Session.getScriptTimeZone(), "yyyy-MM-dd");

  const currentSpeedMPS = parseFloat(weatherData.wind.wind_speed?.value ?? 0);
  const currentGustMPS = parseFloat(weatherData.wind.wind_gust?.value ?? 0);
  const currentDirection = parseFloat(weatherData.wind.wind_direction?.value ?? "NaN");

  const macSuffix = MAC || 'DEFAULT_MAC';
  const DAILY_WIND_MIN_SPEED_PROP_KEY = 'DAILY_WIND_MIN_SPEED_' + macSuffix;
  const DAILY_WIND_MAX_SPEED_PROP_KEY = 'DAILY_WIND_MAX_SPEED_' + macSuffix;
  const DAILY_WIND_MAX_GUST_PROP_KEY = 'DAILY_WIND_MAX_GUST_' + macSuffix;
  const DAILY_WIND_SPEED_SUM_PROP_KEY = 'DAILY_WIND_SPEED_SUM_' + macSuffix;
  const DAILY_WIND_SPEED_COUNT_PROP_KEY = 'DAILY_WIND_SPEED_COUNT_' + macSuffix;
  const DAILY_WIND_SUMMARY_LOG_DATE_PROP_KEY = 'DAILY_WIND_SUMMARY_LOG_DATE_' + macSuffix;

  const props = PropertiesService.getScriptProperties();

  // Part 1: Log anomalies (strong gusts)
  if (currentGustMPS >= HIGH_GUST_THRESHOLD_MS) {
    sheet.appendRow([
      now, "", "", "", "",
      currentSpeedMPS.toFixed(1), currentGustMPS.toFixed(1),
      isNaN(currentDirection) ? "" : currentDirection.toFixed(0),
      "Strong Gust"
    ]);
    Logger.log(`Logged strong gust: ${currentGustMPS.toFixed(1)} m/s`);
  }

  // Part 2: Update and log daily wind statistics
  let dailyMinSpeed = parseFloat(props.getProperty(DAILY_WIND_MIN_SPEED_PROP_KEY));
  let dailyMaxSpeed = parseFloat(props.getProperty(DAILY_WIND_MAX_SPEED_PROP_KEY));
  let dailyMaxGust = parseFloat(props.getProperty(DAILY_WIND_MAX_GUST_PROP_KEY));
  let dailySpeedSum = parseFloat(props.getProperty(DAILY_WIND_SPEED_SUM_PROP_KEY));
  let dailySpeedCount = parseInt(props.getProperty(DAILY_WIND_SPEED_COUNT_PROP_KEY), 10);
  const lastSummaryDate = props.getProperty(DAILY_WIND_SUMMARY_LOG_DATE_PROP_KEY);

  if (lastSummaryDate !== todayDateString) {
    // New day — write previous day's summary
    if (lastSummaryDate && !isNaN(dailySpeedCount) && dailySpeedCount > 0) {
      const avgSpeed = dailySpeedSum / dailySpeedCount;
      const summaryTimestamp = new Date(lastSummaryDate);
      summaryTimestamp.setHours(23, 59, 0, 0);
      sheet.appendRow([
        summaryTimestamp,
        avgSpeed.toFixed(1),
        (isNaN(dailyMinSpeed) ? "" : dailyMinSpeed.toFixed(1)),
        (isNaN(dailyMaxSpeed) ? "" : dailyMaxSpeed.toFixed(1)),
        (isNaN(dailyMaxGust) ? "" : dailyMaxGust.toFixed(1)),
        "", "", "", "Daily Summary"
      ]);
      Logger.log(`Logged daily wind summary for ${lastSummaryDate}`);
    }

    // Reset for new day
    props.setProperty(DAILY_WIND_MIN_SPEED_PROP_KEY, currentSpeedMPS.toString());
    props.setProperty(DAILY_WIND_MAX_SPEED_PROP_KEY, currentSpeedMPS.toString());
    props.setProperty(DAILY_WIND_MAX_GUST_PROP_KEY, currentGustMPS.toString());
    props.setProperty(DAILY_WIND_SPEED_SUM_PROP_KEY, currentSpeedMPS.toString());
    props.setProperty(DAILY_WIND_SPEED_COUNT_PROP_KEY, "1");
    props.setProperty(DAILY_WIND_SUMMARY_LOG_DATE_PROP_KEY, todayDateString);
  } else {
    // Same day — update running stats
    dailyMinSpeed = (isNaN(dailyMinSpeed) || currentSpeedMPS < dailyMinSpeed) ? currentSpeedMPS : dailyMinSpeed;
    dailyMaxSpeed = (isNaN(dailyMaxSpeed) || currentSpeedMPS > dailyMaxSpeed) ? currentSpeedMPS : dailyMaxSpeed;
    dailyMaxGust = (isNaN(dailyMaxGust) || currentGustMPS > dailyMaxGust) ? currentGustMPS : dailyMaxGust;
    dailySpeedSum = (isNaN(dailySpeedSum) ? 0 : dailySpeedSum) + currentSpeedMPS;
    dailySpeedCount = (isNaN(dailySpeedCount) ? 0 : dailySpeedCount) + 1;

    props.setProperty(DAILY_WIND_MIN_SPEED_PROP_KEY, dailyMinSpeed.toString());
    props.setProperty(DAILY_WIND_MAX_SPEED_PROP_KEY, dailyMaxSpeed.toString());
    props.setProperty(DAILY_WIND_MAX_GUST_PROP_KEY, dailyMaxGust.toString());
    props.setProperty(DAILY_WIND_SPEED_SUM_PROP_KEY, dailySpeedSum.toString());
    props.setProperty(DAILY_WIND_SPEED_COUNT_PROP_KEY, dailySpeedCount.toString());
  }
}

// Log atmospheric pressure (at selected hours only)
function logPressure(weatherData) {
  const logHours = [6, 12, 18, 22];
  if (!logHours.includes(new Date().getHours())) return;
  if (!weatherData || !weatherData.pressure) { Logger.log("logPressure: No pressure data."); return; }
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("pressure");
  if (!sheet) { Logger.log("Error: Sheet 'pressure' not found."); return; }
  const rel = parseFloat(weatherData.pressure.relative?.value ?? 0) * PRESSURE_CONVERSION_FACTOR;
  const abs = parseFloat(weatherData.pressure.absolute?.value ?? 0) * PRESSURE_CONVERSION_FACTOR;
  sheet.appendRow([new Date(), Math.round(rel * 10) / 10, Math.round(abs * 10) / 10]);
  Logger.log(`Logged pressure: Relative: ${Math.round(rel * 10) / 10} hPa, Absolute: ${Math.round(abs * 10) / 10} hPa`);
}


// ============================================================
// NOTIFICATIONS (Twilio WhatsApp/SMS + SMSAPI.pl fallback)
// ============================================================

// Send SMS alert via SMSAPI.pl
function sendSMSAlert(message) {
  const token = PropertiesService.getScriptProperties().getProperty("SMSAPI_TOKEN");
  const recipients = PropertiesService.getScriptProperties().getProperty("SMSAPI_RECIPIENTS");
  if (!token || !recipients) {
    Logger.log("Missing SMSAPI_TOKEN or SMSAPI_RECIPIENTS. Skipping SMS.");
    return;
  }
  const url = `https://api.smsapi.pl/sms.do?to=${recipients}&from=Sprinkler&message=${encodeURIComponent(message)}&format=json&access_token=${token}`;
  try {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    Logger.log(`SMS sent: "${message}". API response: ${response.getContentText()}`);
  } catch (e) {
    Logger.log("SMS send error: " + e);
  }
}

// Send notification via Twilio: WhatsApp -> Twilio SMS -> SMSAPI.pl (fallback chain)
function sendNotification(message) {
  const sid = PropertiesService.getScriptProperties().getProperty("TWILIO_SID");
  const authToken = PropertiesService.getScriptProperties().getProperty("TWILIO_AUTH");
  const to = PropertiesService.getScriptProperties().getProperty("TWILIO_TO");
  if (!sid || !authToken || !to) {
    Logger.log("Missing Twilio credentials. Falling back to SMSAPI.");
    sendSMSAlert(message);
    return;
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  const authHeader = 'Basic ' + Utilities.base64Encode(sid + ':' + authToken);
  const whatsappFrom = PropertiesService.getScriptProperties().getProperty("TWILIO_WHATSAPP_FROM") || 'whatsapp:+14155238886';
  const smsFrom = PropertiesService.getScriptProperties().getProperty("TWILIO_SMS_FROM");

  // Attempt 1: WhatsApp
  try {
    const waResp = UrlFetchApp.fetch(url, {
      method: 'post',
      headers: { 'Authorization': authHeader },
      payload: { 'From': whatsappFrom, 'To': 'whatsapp:' + to, 'Body': message },
      muteHttpExceptions: true
    });
    const waResult = JSON.parse(waResp.getContentText());
    if (!waResult.error_code && waResult.status !== 'failed') {
      Logger.log(`WhatsApp OK: "${message}". SID: ${waResult.sid}`);
      return;
    }
    Logger.log(`WhatsApp failed (${waResult.error_code}). Trying Twilio SMS.`);
  } catch (e) {
    Logger.log("WhatsApp error: " + e + ". Trying Twilio SMS.");
  }

  // Attempt 2: SMS via Twilio
  if (smsFrom) {
    try {
      const smsResp = UrlFetchApp.fetch(url, {
        method: 'post',
        headers: { 'Authorization': authHeader },
        payload: { 'From': smsFrom, 'To': to, 'Body': message },
        muteHttpExceptions: true
      });
      const smsResult = JSON.parse(smsResp.getContentText());
      if (!smsResult.error_code && smsResult.status !== 'failed') {
        Logger.log(`Twilio SMS OK: "${message}". SID: ${smsResult.sid}`);
        return;
      }
      Logger.log(`Twilio SMS failed (${smsResult.error_code}). Falling back to SMSAPI.`);
    } catch (e) {
      Logger.log("Twilio SMS error: " + e + ". Falling back to SMSAPI.");
    }
  }

  // Attempt 3: SMSAPI.pl (last resort)
  sendSMSAlert(message);
}


// ============================================================
// FROST RISK MONITORING
// ============================================================

// Log frost risk data to spreadsheet
function logFrostRisk(weatherData) {
  if (!weatherData || !weatherData.outdoor || !weatherData.indoor) { Logger.log("logFrostRisk: Missing outdoor or indoor data."); return; }
  if (!weatherData.outdoor.temperature || weatherData.outdoor.temperature.value === undefined ||
      !weatherData.indoor.temperature || weatherData.indoor.temperature.value === undefined) {
    Logger.log("logFrostRisk: Missing temperature data."); return;
  }
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("frost_risk");
  if (!sheet) { Logger.log("Error: Sheet 'frost_risk' not found."); return; }
  const now = new Date();
  // Note: Ecowitt "indoor" channel = ground-level sensor (not an indoor sensor!)
  const outdoorTempC = Math.round(((parseFloat(weatherData.outdoor.temperature.value ?? "NaN") - 32) * 5 / 9) * 10) / 10;
  const groundTempC = Math.round(((parseFloat(weatherData.indoor.temperature.value ?? "NaN") - 32) * 5 / 9) * 10) / 10;
  const frostRiskFlag = groundTempC < FROST_THRESHOLD_ALERT ? "FROST" : "";
  sheet.appendRow([now, outdoorTempC, groundTempC, frostRiskFlag]);
  Logger.log(`Frost risk logged: Outdoor: ${outdoorTempC}C, Ground: ${groundTempC}C, Risk: ${frostRiskFlag}`);

  // Alert on unreasonable ground temp readings (sensor malfunction?)
  if (isNaN(groundTempC) || groundTempC < MIN_REASONABLE_GROUND_TEMP || groundTempC > MAX_REASONABLE_GROUND_TEMP) {
    const alertKey = 'LAST_ECOWITT_STRANGE_DATA_ALERT_TIME';
    const lastAlertTime = PropertiesService.getScriptProperties().getProperty(alertKey);
    const nowMillis = new Date().getTime();
    if (!lastAlertTime || (nowMillis - parseInt(lastAlertTime, 10)) > DATA_ERROR_ALERT_COOLDOWN_HOURS * 60 * 60 * 1000) {
      sendNotification(`Warning: Unreasonable ground temp: ${groundTempC}C. Check sensor.`);
      PropertiesService.getScriptProperties().setProperty(alertKey, nowMillis.toString());
    }
  }
}

// Analyze temperature trend and send frost warning alert
function predictFrostTrend() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("frost_risk");
  if (!sheet) { Logger.log("Error: Sheet 'frost_risk' not found for trend analysis."); return; }
  const lastRow = sheet.getLastRow();
  if (lastRow < FROST_TREND_MIN_RECORDS) {
    Logger.log(`predictFrostTrend: Not enough data (have ${lastRow}, need ${FROST_TREND_MIN_RECORDS}).`);
    return;
  }
  const numRowsToFetch = Math.min(FROST_TREND_LOOKBACK_RECORDS, lastRow);
  if (numRowsToFetch < FROST_TREND_MIN_RECORDS) return;

  const startRow = lastRow - numRowsToFetch + 1;
  const data = sheet.getRange(startRow, 1, numRowsToFetch, 3).getValues(); // Columns: Time, TempOutdoor, TempGround

  // Check for consistent falling trend
  let trend = true;
  for (let i = 0; i < data.length - 1; i++) {
    const t1 = parseFloat(data[i][2]);
    const t2 = parseFloat(data[i + 1][2]);
    if (isNaN(t1) || isNaN(t2) || t1 <= t2) { trend = false; break; }
  }

  const lastGroundTemp = parseFloat(data[data.length - 1][2]);
  const firstGroundTempInWindow = parseFloat(data[0][2]);
  const lastOutdoorTemp = parseFloat(data[data.length - 1][1]);

  if (isNaN(lastGroundTemp) || isNaN(firstGroundTempInWindow) || isNaN(lastOutdoorTemp)) {
    Logger.log("predictFrostTrend: Key temperatures are NaN. Skipping alert.");
    return;
  }

  if (trend && lastGroundTemp < FROST_THRESHOLD_TREND && (firstGroundTempInWindow - lastGroundTemp >= FROST_TREND_DROP_DEGREES)) {
    const lastAlertTime = PropertiesService.getScriptProperties().getProperty('LAST_FROST_ALERT_TIME');
    const nowMillis = new Date().getTime();
    const alertCooldownHours = 4;

    if (!lastAlertTime || (nowMillis - parseInt(lastAlertTime, 10)) > alertCooldownHours * 60 * 60 * 1000) {
      const alertMessage = `Possible frost: ground temp falling (${firstGroundTempInWindow.toFixed(1)}C -> ${lastGroundTemp.toFixed(1)}C). Air temp: ${lastOutdoorTemp.toFixed(1)}C. Prepare protection.`;
      sendNotification(alertMessage);
      PropertiesService.getScriptProperties().setProperty('LAST_FROST_ALERT_TIME', nowMillis.toString());
      Logger.log("Sent frost trend alert.");
    } else {
      Logger.log("Frost trend detected, but alert is on cooldown.");
    }
  } else {
    Logger.log("predictFrostTrend: Frost alert conditions not met.");
  }
}


// ============================================================
// OPENSPRINKLER CONTROL
// ============================================================

// Run an OpenSprinkler program by ID
function runOpenSprinklerProgram(programId) {
  const plainPassword = OPENSPRINKLER_PASSWORD;
  if (!plainPassword || !OPENSPRINKLER_OTC) { Logger.log("Error: Missing OS password or OTC."); return false; }
  const hashedPassword = calculateMD5(plainPassword);
  if (!hashedPassword) { Logger.log("Error: MD5 hash failed."); return false; }
  const url = `https://cloud.openthings.io/forward/v1/${OPENSPRINKLER_OTC}/mp?pw=${hashedPassword}&pid=${programId}&uwt=0`;
  Logger.log(`Starting OS program (PID=${programId})...`);
  try {
    const options = { muteHttpExceptions: true, readTimeoutMillis: 30000 };
    const response = UrlFetchApp.fetch(url, options);
    const text = response.getContentText();
    Logger.log(`Program ${programId} — HTTP: ${response.getResponseCode()}, Response: ${text}`);
    if (response.getResponseCode() !== 200) return false;
    try {
      const jsonResponse = JSON.parse(text);
      if (jsonResponse.result === 1) { Logger.log(`Program ${programId} started successfully.`); return true; }
      else { Logger.log(`Failed to start program ${programId} (result: ${jsonResponse.result}).`); return false; }
    } catch (parseError) { return false; }
  } catch (e) { Logger.log(`Critical error starting OS program ${programId}: ${e}`); return false; }
}

// Stop frost protection: clear all triggers and reset OpenSprinkler
function stopFrostProtection() {
  Logger.log("stopFrostProtection: Stopping frost loop...");
  const triggers = ScriptApp.getProjectTriggers();
  let deletedTriggersCount = 0;
  triggers.forEach(t => {
    const handler = t.getHandlerFunction();
    if (handler === "frostLoopRecheckTrigger" || handler === "frostPairNextTrigger") {
      ScriptApp.deleteTrigger(t);
      deletedTriggersCount++;
    }
  });
  PropertiesService.getScriptProperties().deleteProperty('FROST_CURRENT_PAIR_INDEX');
  PropertiesService.getScriptProperties().setProperty('FROST_LOOP_ACTIVE', 'false');
  Logger.log(`stopFrostProtection: Deleted ${deletedTriggersCount} triggers.`);

  // Reset all stations on OpenSprinkler
  Logger.log("stopFrostProtection: Resetting all OpenSprinkler stations...");
  const hashedPassword = calculateMD5(OPENSPRINKLER_PASSWORD);
  if (hashedPassword && OPENSPRINKLER_OTC) {
    const url = `https://cloud.openthings.io/forward/v1/${OPENSPRINKLER_OTC}/cv?pw=${hashedPassword}&rsn=1`;
    try {
      const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true, readTimeoutMillis: 30000 });
      Logger.log(`Station reset (rsn=1). Response: ${response.getContentText()}`);
    } catch (e) {
      Logger.log(`Error sending station reset: ${e}`);
    }
  }
}


// ============================================================
// FROST PAIR CYCLE CONTROL
// ============================================================

// Start frost protection cycle: runs zone pairs sequentially
function startFrostPairCycle() {
  Logger.log(`Frost cycle start: ${FROST_PAIRS.length} pairs, ${FROST_PAIR_DURATION_SECONDS}s each.`);
  PropertiesService.getScriptProperties().setProperty('FROST_CURRENT_PAIR_INDEX', '0');
  return runFrostPairAtIndex(0);
}

// Run a specific pair of zones by index
function runFrostPairAtIndex(index) {
  if (index >= FROST_PAIRS.length) {
    Logger.log("All pairs completed. Scheduling recheck.");
    scheduleFrostLoopRecheck();
    return true;
  }

  const pair = FROST_PAIRS[index];
  const pw = calculateMD5(OPENSPRINKLER_PASSWORD);
  if (!pw || !OPENSPRINKLER_OTC) {
    Logger.log("Error: Missing OS password or OTC.");
    return false;
  }

  let allOk = true;
  for (const zone of pair) {
    const sid = zone - 1;
    const url = `https://cloud.openthings.io/forward/v1/${OPENSPRINKLER_OTC}/cm?pw=${pw}&sid=${sid}&en=1&t=${FROST_PAIR_DURATION_SECONDS}`;
    try {
      const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, readTimeoutMillis: 15000 });
      Logger.log(`S${String(zone).padStart(2,'0')} ON ${FROST_PAIR_DURATION_SECONDS}s — ${resp.getContentText()}`);
      try {
        const j = JSON.parse(resp.getContentText());
        if (j.result !== 1) allOk = false;
      } catch (e) { allOk = false; }
    } catch (e) {
      Logger.log(`Error zone ${zone}: ${e}`);
      allOk = false;
    }
  }

  Logger.log(`Pair ${index + 1}/${FROST_PAIRS.length} (S${pair.join('+S')}) started.`);

  // Schedule next pair or recheck
  const nextIndex = index + 1;
  if (nextIndex < FROST_PAIRS.length) {
    PropertiesService.getScriptProperties().setProperty('FROST_CURRENT_PAIR_INDEX', String(nextIndex));
    ScriptApp.getProjectTriggers().forEach(t => {
      if (t.getHandlerFunction() === 'frostPairNextTrigger') ScriptApp.deleteTrigger(t);
    });
    ScriptApp.newTrigger('frostPairNextTrigger')
      .timeBased()
      .after((FROST_PAIR_DURATION_SECONDS + FROST_PAIR_GAP_SECONDS) * 1000)
      .create();
    Logger.log(`Next pair ${nextIndex + 1} scheduled in ${FROST_PAIR_DURATION_SECONDS + FROST_PAIR_GAP_SECONDS}s.`);
  } else {
    // Last pair — schedule recheck after it finishes
    ScriptApp.getProjectTriggers().forEach(t => {
      if (t.getHandlerFunction() === 'frostLoopRecheckTrigger') ScriptApp.deleteTrigger(t);
    });
    ScriptApp.newTrigger('frostLoopRecheckTrigger')
      .timeBased()
      .after(FROST_LOOP_RECHECK_AFTER_LAST_PAIR_SECONDS * 1000)
      .create();
    Logger.log(`Last pair. Recheck in ${FROST_LOOP_RECHECK_AFTER_LAST_PAIR_SECONDS}s.`);
  }

  return allOk;
}

// Trigger: run next pair in sequence
function frostPairNextTrigger() {
  Logger.log("frostPairNextTrigger: FIRED");
  if (PropertiesService.getScriptProperties().getProperty('FROST_LOOP_ACTIVE') !== 'true') {
    Logger.log("Loop inactive — skipping next pair.");
    return;
  }
  const index = parseInt(PropertiesService.getScriptProperties().getProperty('FROST_CURRENT_PAIR_INDEX') || '0', 10);
  runFrostPairAtIndex(index);
}


// ============================================================
// VINEYARD IRRIGATION (non-frost, plain watering)
// ============================================================

// Trigger: run next irrigation pair in continuous cycle
function irrigateNextPairTrigger() {
  const props = PropertiesService.getScriptProperties();
  const index = parseInt(props.getProperty('IRRIGATE_PAIR_INDEX') || '0', 10);
  const durationSeconds = parseInt(props.getProperty('IRRIGATE_PAIR_DURATION_SECONDS') || '600', 10);

  if (index >= FROST_PAIRS.length) {
    Logger.log("Irrigation complete — all pairs done.");
    return;
  }

  const pair = FROST_PAIRS[index];
  const pw = calculateMD5(OPENSPRINKLER_PASSWORD);

  for (const zone of pair) {
    const sid = zone - 1;
    const url = `https://cloud.openthings.io/forward/v1/${OPENSPRINKLER_OTC}/cm?pw=${pw}&sid=${sid}&en=1&t=${durationSeconds}`;
    try {
      const resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true, readTimeoutMillis: 15000 });
      Logger.log(`Irrigate S${String(zone).padStart(2,'0')} ON ${durationSeconds}s — ${resp.getContentText()}`);
    } catch (e) {
      Logger.log(`Irrigation error S${zone}: ${e}`);
    }
  }
  props.setProperty('IRRIGATE_CURRENT_PAIR', JSON.stringify(pair));
  props.setProperty('IRRIGATE_PAIR_START_TIME', new Date().toISOString());
  Logger.log(`Irrigation pair ${index + 1}/${FROST_PAIRS.length} (S${pair.join('+S')}) started for ${durationSeconds}s.`);

  const nextIndex = index + 1;
  const cycle = parseInt(props.getProperty('IRRIGATE_CYCLE') || '1', 10);
  // After last pair, loop back to first (new cycle)
  const actualNext = nextIndex >= FROST_PAIRS.length ? 0 : nextIndex;
  const nextCycle = nextIndex >= FROST_PAIRS.length ? cycle + 1 : cycle;

  props.setProperty('IRRIGATE_PAIR_INDEX', String(actualNext));
  props.setProperty('IRRIGATE_CYCLE', String(nextCycle));
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'irrigateNextPairTrigger') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('irrigateNextPairTrigger')
    .timeBased()
    .after((durationSeconds + 15) * 1000)
    .create();
}


// ============================================================
// FROST RISK CHECK IN LAWN MODE
// ============================================================

// Check frost risk when system is in LAWN mode — sends alert to switch valves/mode
function checkFrostRiskInLawnMode_() {
  const now = new Date();
  const month = now.getMonth();
  const day = now.getDate();
  // Only check during frost season (April-mid June, adjust for your region)
  const outsideSeason = (month > 5 || month < 3 || (month === 5 && day >= 15));
  if (outsideSeason) return false;

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("frost_risk");
  if (!sheet) return false;
  const lastRow = sheet.getLastRow();
  if (lastRow < FROST_TREND_MIN_RECORDS) return false;

  const rawValues = sheet.getRange(lastRow - FROST_TREND_MIN_RECORDS + 1, 3, FROST_TREND_MIN_RECORDS, 1).getValues();
  const temps = rawValues.map(r => parseFloat(r[0])).filter(t => !isNaN(t));
  if (temps.length < FROST_TREND_MIN_RECORDS) return false;

  const latestTemp = temps[temps.length - 1];

  let isFalling = true;
  for (let i = 1; i < temps.length; i++) {
    if (temps[i] >= temps[i - 1]) { isFalling = false; break; }
  }

  const shouldAlert = (isFalling && latestTemp < FROST_LOOP_START_THRESHOLD) || (latestTemp < FROST_LOOP_ABSOLUTE_START_THRESHOLD);
  if (!shouldAlert) return false;

  // Cooldown — max 1 alert per 2 hours
  const props = PropertiesService.getScriptProperties();
  const lastAlert = props.getProperty('LAWN_FROST_ALERT_TIME');
  const nowMs = now.getTime();
  if (lastAlert && (nowMs - parseInt(lastAlert, 10)) < 2 * 60 * 60 * 1000) {
    Logger.log("checkFrostRiskInLawnMode_: Alert on cooldown (2h).");
    return false;
  }

  const msg = `FROST WARNING! System is in LAWN mode but ground temp is ${latestTemp.toFixed(1)}C${isFalling ? ' (falling trend)' : ''}. Switch valves to vineyard and enable FROST mode!`;
  sendNotification(msg);
  sendSMSAlert(msg);
  props.setProperty('LAWN_FROST_ALERT_TIME', nowMs.toString());
  return true;
}


// ============================================================
// AUTOMATIC FROST MONITORING (main decision logic)
// ============================================================

// Main frost monitoring function — called every 15 min by getWeatherToSheet
function monitorFrostRiskAuto() {
  // Check mode
  if (getCurrentMode() === 'lawn') {
    const lawnFrostCheck = checkFrostRiskInLawnMode_();
    if (lawnFrostCheck) {
      Logger.log("monitorFrostRiskAuto: LAWN mode but frost risk detected — alert sent.");
    } else {
      Logger.log("monitorFrostRiskAuto: LAWN mode, no frost risk.");
    }
    return;
  }

  // Season guard (with manual override)
  const now = new Date();
  const month = now.getMonth(); // 0 = Jan, 5 = Jun, 11 = Dec
  const day = now.getDate();
  const seasonOverride = PropertiesService.getScriptProperties().getProperty('FROST_SEASON_MANUAL_OVERRIDE') === 'true';

  // Calendar season: April 1 – June 14. Adjust for your region!
  const outsideCalendarSeason = (month > 5 || month < 3 || (month === 5 && day >= 15));
  if (outsideCalendarSeason && !seasonOverride) {
    Logger.log(`monitorFrostRiskAuto: Outside frost season (date: ${now.toLocaleDateString()}, override: ${seasonOverride}). Disabled.`);
    if (PropertiesService.getScriptProperties().getProperty('FROST_LOOP_ACTIVE') === 'true') {
      Logger.log("Active loop detected outside season. Stopping.");
      stopFrostProtection();
    }
    return;
  }

  Logger.log("monitorFrostRiskAuto: Checking frost risk (in season)...");
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("frost_risk");
  if (!sheet) { Logger.log("Error: Sheet 'frost_risk' not found."); return; }

  const lastRow = sheet.getLastRow();
  if (lastRow < FROST_TREND_MIN_RECORDS) {
    Logger.log(`monitorFrostRiskAuto: Not enough data (have ${lastRow}, need ${FROST_TREND_MIN_RECORDS}).`);
    return;
  }

  const numRecordsToFetch = FROST_TREND_MIN_RECORDS;
  const startRow = lastRow - numRecordsToFetch + 1;
  const rawValues = sheet.getRange(startRow, 3, numRecordsToFetch, 1).getValues();
  const temps = rawValues.map(r => parseFloat(r[0])).filter(t => !isNaN(t));

  if (temps.length < numRecordsToFetch) {
    Logger.log(`monitorFrostRiskAuto: Not enough valid ground temp readings (have ${temps.length}, need ${numRecordsToFetch}).`);
    return;
  }

  // Check for falling trend
  let isFalling = true;
  for (let i = 1; i < temps.length; i++) {
    if (temps[i] >= temps[i - 1]) { isFalling = false; break; }
  }

  const latestGroundTemp = temps[temps.length - 1];
  Logger.log(`monitorFrostRiskAuto: Ground temp: ${latestGroundTemp.toFixed(1)}C, Falling trend: ${isFalling}`);

  const isLoopActive = PropertiesService.getScriptProperties().getProperty('FROST_LOOP_ACTIVE') === 'true';
  const canStartLoop = (isFalling && latestGroundTemp < FROST_LOOP_START_THRESHOLD) || (latestGroundTemp < FROST_LOOP_ABSOLUTE_START_THRESHOLD);

  if (canStartLoop && !isLoopActive) {
    // START frost loop
    let startReason = "";
    if (latestGroundTemp < FROST_LOOP_ABSOLUTE_START_THRESHOLD) {
      startReason = `(Temp=${latestGroundTemp.toFixed(1)}C < ${FROST_LOOP_ABSOLUTE_START_THRESHOLD}C absolute threshold)`;
    } else {
      startReason = `(Temp=${latestGroundTemp.toFixed(1)}C < ${FROST_LOOP_START_THRESHOLD}C, falling trend)`;
    }
    Logger.log(`Conditions met to START frost loop ${startReason}. Starting pair cycle.`);
    PropertiesService.getScriptProperties().setProperty('FROST_LOOP_ACTIVE', 'true');
    const success = startFrostPairCycle();
    if (success) {
      var frostStartMsg = `FROST LOOP STARTED! Ground temp: ${latestGroundTemp.toFixed(1)}C ${startReason}. Cycle: ${FROST_PAIRS.length} pairs x ${FROST_PAIR_DURATION_SECONDS}s.`;
      sendSMSAlert(frostStartMsg);
      sendNotification(frostStartMsg);
    } else {
      Logger.log("Failed to start pair cycle. Resetting FROST_LOOP_ACTIVE.");
      PropertiesService.getScriptProperties().setProperty('FROST_LOOP_ACTIVE', 'false');
    }
  }
  else if (latestGroundTemp >= FROST_LOOP_STOP_THRESHOLD && isLoopActive) {
    // STOP frost loop
    Logger.log(`Conditions met to STOP frost loop (Temp=${latestGroundTemp.toFixed(1)}C >= ${FROST_LOOP_STOP_THRESHOLD}C).`);
    stopFrostProtection();
    sendNotification(`Frost loop STOPPED. Ground temp: ${latestGroundTemp.toFixed(1)}C.`);
  }
  else if (latestGroundTemp < FROST_LOOP_STOP_THRESHOLD && isLoopActive) {
    // Continue frost loop
    Logger.log(`Frost loop still active (Temp=${latestGroundTemp.toFixed(1)}C < ${FROST_LOOP_STOP_THRESHOLD}C). Restarting pair cycle.`);
    startFrostPairCycle();
  }

  // Dynamic intensive logging trigger management
  const triggers = ScriptApp.getProjectTriggers();
  const hasIntensiveTrigger = triggers.some(t => t.getHandlerFunction() === "logFrostRiskIntensive");

  if (isFalling && latestGroundTemp < FROST_THRESHOLD_TREND && !hasIntensiveTrigger) {
    ScriptApp.newTrigger("logFrostRiskIntensive").timeBased().everyMinutes(15).create();
    Logger.log(`Activated intensive frost logging (every 15 min). Ground temp: ${latestGroundTemp.toFixed(1)}C.`);
  }
  if ((latestGroundTemp >= FROST_THRESHOLD_TREND || !isFalling) && hasIntensiveTrigger) {
    triggers.filter(t => t.getHandlerFunction() === "logFrostRiskIntensive").forEach(t => {
      ScriptApp.deleteTrigger(t);
      Logger.log("Deactivated intensive frost logging (temp rising or no falling trend).");
    });
  }
  Logger.log("monitorFrostRiskAuto: Done.");
}

// Schedule frost loop recheck trigger
function scheduleFrostLoopRecheck() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === "frostLoopRecheckTrigger") ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger("frostLoopRecheckTrigger")
    .timeBased()
    .after(FROST_LOOP_RECHECK_AFTER_LAST_PAIR_SECONDS * 1000)
    .create();
  Logger.log(`Scheduled frostLoopRecheckTrigger in ${FROST_LOOP_RECHECK_AFTER_LAST_PAIR_SECONDS}s.`);
}

// Frost loop recheck trigger handler
function frostLoopRecheckTrigger() {
  Logger.log("frostLoopRecheckTrigger: FIRED");
  const loopStatus = PropertiesService.getScriptProperties().getProperty('FROST_LOOP_ACTIVE');

  if (loopStatus === 'true') {
    Logger.log("Loop active — calling monitorFrostRiskAuto...");
    monitorFrostRiskAuto();
  } else {
    Logger.log("Loop inactive — cleaning up stale trigger.");
    ScriptApp.getProjectTriggers().forEach(t => {
      if (t.getHandlerFunction() === "frostLoopRecheckTrigger") ScriptApp.deleteTrigger(t);
    });
  }
}


// ============================================================
// DAILY SPRINKLER SUMMARY LOG
// ============================================================

function logDailySprinklerSummary() {
  Logger.log("Starting logDailySprinklerSummary...");
  const sheetName = "sprinkler_status";
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
  if (!sheet) { Logger.log(`Error: Sheet '${sheetName}' not found.`); return; }

  const logs = fetchSprinklerLogData(2);
  if (!logs || !Array.isArray(logs)) { Logger.log("Failed to fetch OS logs. Aborting."); return; }

  const summary = {};
  const now = new Date();
  const daysToProcess = [0, 1];
  const flowRateLPS = (FLIPPERS_PER_ZONE * FLIPPER_FLOW_RATE_LPH) / 3600;

  for (const dayOffset of daysToProcess) {
    const targetDate = new Date();
    targetDate.setDate(now.getDate() - dayOffset);
    const dateStr = targetDate.toISOString().split("T")[0];

    const startOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 0, 0, 0, 0).getTime();
    const endOfDay = new Date(targetDate.getFullYear(), targetDate.getMonth(), targetDate.getDate(), 23, 59, 59, 999).getTime();

    for (const logEntry of logs) {
      if (!Array.isArray(logEntry) || logEntry.length < 4) continue;
      const pid = parseInt(logEntry[0], 10);
      const sid = parseInt(logEntry[1], 10);
      const dur = parseInt(logEntry[2], 10);
      const endTimestampSeconds = parseInt(logEntry[3], 10);
      if (isNaN(pid) || isNaN(sid) || isNaN(dur) || isNaN(endTimestampSeconds)) continue;

      const endMillis = endTimestampSeconds * 1000;
      if (endMillis >= startOfDay && endMillis <= endOfDay) {
        const zoneId = sid + 1;
        if (!summary[dateStr]) summary[dateStr] = {};
        if (!summary[dateStr][zoneId]) summary[dateStr][zoneId] = { runs: 0, totalSeconds: 0 };
        summary[dateStr][zoneId].runs += 1;
        summary[dateStr][zoneId].totalSeconds += dur;
      }
    }
  }

  const headerRows = 1;
  const existingData = sheet.getLastRow() > headerRows ? sheet.getRange(headerRows + 1, 1, sheet.getLastRow() - headerRows, 2).getValues() : [];
  const existingEntries = new Set(
    existingData.map(row => {
      const d = new Date(row[0]);
      const datePart = !isNaN(d.getTime()) ? d.toISOString().split("T")[0] : String(row[0]);
      return `${datePart}|${row[1]}`;
    })
  );

  const rowsToWrite = [];
  for (const dateStr in summary) {
    for (const zoneIdStr in summary[dateStr]) {
      const zoneId = parseInt(zoneIdStr, 10);
      const key = `${dateStr}|${zoneId}`;
      if (!OPENSPRINKLER_ZONES.includes(zoneId) || existingEntries.has(key)) continue;
      const zoneData = summary[dateStr][zoneId];
      const totalMinutes = Math.round(zoneData.totalSeconds / 60);
      const estimatedWaterLiters = Math.round(zoneData.totalSeconds * flowRateLPS);
      rowsToWrite.push([dateStr, zoneId, zoneData.runs, totalMinutes, estimatedWaterLiters]);
    }
  }

  if (rowsToWrite.length > 0) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rowsToWrite.length, rowsToWrite[0].length).setValues(rowsToWrite);
  }
  Logger.log(`logDailySprinklerSummary: Added ${rowsToWrite.length} new rows.`);
}


// ============================================================
// MAIN ENTRY POINT (called every 15 min by trigger)
// ============================================================

function getWeatherToSheet() {
  Logger.log("Starting getWeatherToSheet...");
  const weatherData = fetchWeatherData();
  if (!weatherData) {
    Logger.log("getWeatherToSheet: Failed to fetch weather data.");
    // Alert on persistent data fetch failures
    const alertKey = 'LAST_ECOWITT_FETCH_ERROR_ALERT_TIME';
    const lastAlertTime = PropertiesService.getScriptProperties().getProperty(alertKey);
    const nowMillis = new Date().getTime();
    if (!lastAlertTime || (nowMillis - parseInt(lastAlertTime, 10)) > DATA_ERROR_ALERT_COOLDOWN_HOURS * 60 * 60 * 1000) {
      sendNotification("Warning: Failed to fetch weather data from Ecowitt! Check logs.");
      PropertiesService.getScriptProperties().setProperty(alertKey, nowMillis.toString());
    }
    return;
  }
  logVineyardTempHumidity(weatherData);
  logSolarUV(weatherData);
  logRainfall(weatherData);
  logWind(weatherData);
  logPressure(weatherData);
  logFrostRisk(weatherData);
  logPowderyMildewRisk();
  predictFrostTrend();
  monitorFrostRiskAuto();
  Logger.log("getWeatherToSheet: Done.");
}


// ============================================================
// MODE MANAGEMENT (frost / lawn)
// ============================================================

// Get current mode: "frost" or "lawn"
function getCurrentMode() {
  const mode = PropertiesService.getScriptProperties().getProperty('SYSTEM_MODE');
  return mode || 'frost';
}

// Switch to LAWN mode
function switchToLawnMode() {
  const props = PropertiesService.getScriptProperties();
  // Stop frost loop if active
  if (props.getProperty('FROST_LOOP_ACTIVE') === 'true') {
    Logger.log("switchToLawnMode: Stopping active frost loop...");
    stopFrostProtection();
  }
  props.setProperty('SYSTEM_MODE', 'lawn');
  removeLawnTriggers();

  // Create daily lawn watering trigger
  ScriptApp.newTrigger('runLawnWatering')
    .timeBased()
    .atHour(LAWN_START_HOUR)
    .nearMinute(LAWN_START_MINUTE)
    .everyDays(1)
    .create();

  Logger.log(`Switched to LAWN mode. Daily at ${LAWN_START_HOUR}:${String(LAWN_START_MINUTE).padStart(2,'0')}, zones: ${LAWN_ZONES.join(', ')}, ${LAWN_DURATION_MINUTES} min each.`);
  sendNotification(`LAWN mode active. Daily at ${LAWN_START_HOUR}:00, zones ${LAWN_ZONES.join(', ')}, ${LAWN_DURATION_MINUTES} min each.`);
}

// Switch to FROST mode
function switchToFrostMode() {
  PropertiesService.getScriptProperties().setProperty('SYSTEM_MODE', 'frost');
  removeLawnTriggers();
  Logger.log("Switched to FROST mode. Frost monitoring active.");
  sendNotification("FROST mode active. Monitoring enabled.");
}

// Show current mode in logs
function showCurrentMode() {
  const mode = getCurrentMode();
  const loopActive = PropertiesService.getScriptProperties().getProperty('FROST_LOOP_ACTIVE');
  Logger.log(`Current mode: ${mode.toUpperCase()}, frost loop: ${loopActive}`);
  return mode;
}

// Remove lawn-related triggers
function removeLawnTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  let removed = 0;
  triggers.forEach(t => {
    if (t.getHandlerFunction() === 'runLawnWatering' || t.getHandlerFunction() === 'runLawnZoneSequence') {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  if (removed > 0) Logger.log(`Removed ${removed} lawn triggers.`);
}


// ============================================================
// LAWN WATERING
// ============================================================

// Run lawn watering: zones sequentially, each for LAWN_DURATION_MINUTES
function runLawnWatering() {
  if (getCurrentMode() !== 'lawn') {
    Logger.log("runLawnWatering: Not in lawn mode, skipping.");
    return;
  }

  Logger.log(`Lawn watering start: zones ${LAWN_ZONES.join(', ')}, ${LAWN_DURATION_MINUTES} min each.`);

  const plainPassword = OPENSPRINKLER_PASSWORD;
  if (!plainPassword || !OPENSPRINKLER_OTC) {
    Logger.log("Error: Missing OS password or OTC.");
    return;
  }
  const hashedPassword = calculateMD5(plainPassword);
  const durationSeconds = LAWN_DURATION_MINUTES * 60;

  for (let i = 0; i < LAWN_ZONES.length; i++) {
    const zoneIndex = LAWN_ZONES[i] - 1; // OS uses 0-based indices

    if (i > 0) {
      // Schedule later zones via triggers (GAS has 6 min execution limit)
      const delaySeconds = i * durationSeconds;
      const triggerTime = new Date(new Date().getTime() + delaySeconds * 1000);
      PropertiesService.getScriptProperties().setProperty('LAWN_NEXT_ZONE_INDEX', String(i));
      ScriptApp.newTrigger('runLawnZoneSequence')
        .timeBased()
        .at(triggerTime)
        .create();
      Logger.log(`Scheduled zone ${LAWN_ZONES[i]} at ${triggerTime.toLocaleString()}`);
      return;
    }

    // First zone — start immediately
    const url = `https://cloud.openthings.io/forward/v1/${OPENSPRINKLER_OTC}/cm?pw=${hashedPassword}&sid=${zoneIndex}&en=1&t=${durationSeconds}`;
    try {
      const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true, readTimeoutMillis: 30000 });
      Logger.log(`Lawn zone ${LAWN_ZONES[i]} (sid=${zoneIndex}) started for ${LAWN_DURATION_MINUTES} min. Response: ${response.getContentText()}`);

      if (LAWN_ZONES.length > 1) {
        PropertiesService.getScriptProperties().setProperty('LAWN_NEXT_ZONE_INDEX', '1');
        const nextTime = new Date(new Date().getTime() + durationSeconds * 1000 + 30000);
        ScriptApp.newTrigger('runLawnZoneSequence')
          .timeBased()
          .at(nextTime)
          .create();
        Logger.log(`Scheduled next zone ${LAWN_ZONES[1]} at ${nextTime.toLocaleString()}`);
      }
    } catch (e) {
      Logger.log(`Error starting lawn zone ${LAWN_ZONES[i]}: ${e}`);
    }
    return;
  }
}

// Continue lawn zone sequence (called by trigger)
function runLawnZoneSequence() {
  if (getCurrentMode() !== 'lawn') {
    Logger.log("runLawnZoneSequence: Not in lawn mode, skipping.");
    removeLawnTriggers();
    return;
  }

  const props = PropertiesService.getScriptProperties();
  const nextIndex = parseInt(props.getProperty('LAWN_NEXT_ZONE_INDEX') || '0');

  if (nextIndex >= LAWN_ZONES.length) {
    Logger.log("Lawn watering complete — all zones done.");
    removeLawnTriggers();
    return;
  }

  const zoneIndex = LAWN_ZONES[nextIndex] - 1;
  const durationSeconds = LAWN_DURATION_MINUTES * 60;
  const hashedPassword = calculateMD5(OPENSPRINKLER_PASSWORD);

  const url = `https://cloud.openthings.io/forward/v1/${OPENSPRINKLER_OTC}/cm?pw=${hashedPassword}&sid=${zoneIndex}&en=1&t=${durationSeconds}`;

  try {
    const response = UrlFetchApp.fetch(url, { muteHttpExceptions: true, readTimeoutMillis: 30000 });
    Logger.log(`Lawn zone ${LAWN_ZONES[nextIndex]} (sid=${zoneIndex}) started for ${LAWN_DURATION_MINUTES} min. Response: ${response.getContentText()}`);

    const nextNextIndex = nextIndex + 1;
    if (nextNextIndex < LAWN_ZONES.length) {
      props.setProperty('LAWN_NEXT_ZONE_INDEX', String(nextNextIndex));
      const nextTime = new Date(new Date().getTime() + durationSeconds * 1000 + 30000);
      ScriptApp.getProjectTriggers().forEach(t => {
        if (t.getHandlerFunction() === 'runLawnZoneSequence') ScriptApp.deleteTrigger(t);
      });
      ScriptApp.newTrigger('runLawnZoneSequence')
        .timeBased()
        .at(nextTime)
        .create();
      Logger.log(`Scheduled zone ${LAWN_ZONES[nextNextIndex]} at ${nextTime.toLocaleString()}`);
    } else {
      Logger.log("Lawn watering complete — last zone.");
      sendNotification(`Lawn watering done. Zones ${LAWN_ZONES.join(', ')} watered (${LAWN_ZONES.length} x ${LAWN_DURATION_MINUTES} min).`);
      ScriptApp.getProjectTriggers().forEach(t => {
        if (t.getHandlerFunction() === 'runLawnZoneSequence') ScriptApp.deleteTrigger(t);
      });
    }
  } catch (e) {
    Logger.log(`Error in lawn zone ${LAWN_ZONES[nextIndex]}: ${e}`);
  }
}


// ============================================================
// TEST & UTILITY FUNCTIONS
// ============================================================

// Test SMS delivery
function testSMS() {
  sendSMSAlert("Test SMS from OpenSprinkler Frost Protection system.");
  Logger.log("Test SMS sent.");
}

// Manually force frost loop start (for testing)
function testForceFrostLoopStart() {
  Logger.log("MANUAL: Forcing frost loop start...");
  stopFrostProtection();
  Utilities.sleep(2000);
  PropertiesService.getScriptProperties().setProperty('FROST_LOOP_ACTIVE', 'true');
  const success = startFrostPairCycle();
  if (success) {
    Logger.log(`Frost pair cycle started (${FROST_PAIRS.length} pairs x ${FROST_PAIR_DURATION_SECONDS}s).`);
  } else {
    Logger.log("Failed to start pair cycle. Resetting.");
    PropertiesService.getScriptProperties().setProperty('FROST_LOOP_ACTIVE', 'false');
  }
}

// Test intensive frost monitoring
function testIntensiveFrostMonitoringTrigger() {
  Logger.log("--- Manual test: intensive frost monitoring ---");
  monitorFrostRiskAuto();
  Logger.log("--- Test complete ---");
}

// WhatsApp sandbox keepalive (ping every 48h to prevent session expiry)
function keepAliveSandbox() {
  const sid = PropertiesService.getScriptProperties().getProperty("TWILIO_SID");
  const authToken = PropertiesService.getScriptProperties().getProperty("TWILIO_AUTH");
  const to = PropertiesService.getScriptProperties().getProperty("TWILIO_TO");
  if (!sid || !authToken || !to) { Logger.log("keepAliveSandbox: Missing Twilio credentials."); return; }
  const whatsappFrom = PropertiesService.getScriptProperties().getProperty("TWILIO_WHATSAPP_FROM") || 'whatsapp:+14155238886';
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
  try {
    const response = UrlFetchApp.fetch(url, {
      method: 'post',
      headers: { 'Authorization': 'Basic ' + Utilities.base64Encode(sid + ':' + authToken) },
      payload: { 'From': whatsappFrom, 'To': 'whatsapp:' + to, 'Body': 'System OK' },
      muteHttpExceptions: true
    });
    const result = JSON.parse(response.getContentText());
    Logger.log(`Sandbox keepalive: status=${result.status}, error=${result.error_code}`);
  } catch (e) {
    Logger.log("Sandbox keepalive error: " + e);
  }
}

// Set up sandbox keepalive trigger (run once manually)
function setupSandboxKeepalive() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'keepAliveSandbox') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('keepAliveSandbox')
    .timeBased()
    .everyHours(48)
    .create();
  Logger.log("Sandbox keepalive trigger set (every 48h).");
}
