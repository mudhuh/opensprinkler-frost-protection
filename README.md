# OpenSprinkler Frost Protection & Lawn Irrigation

Automated frost protection and lawn irrigation system for vineyards (or any frost-sensitive crops), built on **Google Apps Script** + **OpenSprinkler** + **Ecowitt** weather station.

When ground-level temperature drops below configurable thresholds, the system automatically activates sprinkler zones in pairs to protect vines from frost damage using the heat of fusion principle (water freezing on buds releases heat, keeping them above lethal temperatures). Outside frost season, the same system handles daily lawn/garden irrigation on a schedule.

## Features

- **Automatic frost protection** -- monitors ground-level temperature via Ecowitt sensor, starts sprinkler pairs when frost conditions are detected
- **Trend-based early warning** -- analyzes temperature trend over recent readings, sends alerts before frost actually hits
- **Zone pair cycling** -- runs zones in configurable pairs (water pressure typically cannot handle 3+ zones simultaneously), with automatic cycling and rechecks
- **Dual mode operation** -- switch between FROST mode (monitoring + auto-activation) and LAWN mode (daily scheduled irrigation)
- **Cross-mode frost alerts** -- even in LAWN mode, the system monitors for frost risk and sends urgent alerts to switch valves
- **Season guard** -- frost monitoring only active during configurable calendar season (default: April 1 -- June 14), with manual override
- **Multi-channel notifications** -- Twilio WhatsApp, Twilio SMS, and SMSAPI.pl with automatic fallback chain
- **Weather data logging** -- temperature, humidity, rainfall, wind, pressure, solar/UV to Google Sheets
- **Powdery mildew risk tracking** -- monitors humidity + temperature conditions for disease risk
- **Web control panel** -- mobile-friendly HTML panel for remote monitoring and control
- **REST API** -- full control via GET/POST endpoints (status, mode switch, manual zone control)
- **Daily sprinkler summary** -- logs run times and estimated water usage per zone

## Architecture

```
Ecowitt Weather Station ──── Ecowitt Cloud API v3
         (ground sensor)              |
                                      v
                            Google Apps Script (Code.js)
                           /          |           \
                          v           v            v
                   Google Sheets   OpenSprinkler   Twilio / SMSAPI
                   (data logs)     Cloud API       (alerts)
                                      |
                                      v
                              Sprinkler Valves
                              (zones S01-S16)
```

**Key insight:** The Ecowitt "indoor" channel is actually a ground-level temperature sensor placed near the vine buds -- not an indoor sensor. This gives the most accurate frost risk reading.

## Prerequisites

1. **[OpenSprinkler](https://opensprinkler.com)** controller with cloud access enabled (cloud.openthings.io)
2. **[Ecowitt](https://www.ecowitt.com)** weather station with:
   - Outdoor temperature/humidity sensor
   - A second sensor placed at ground level near your crops (configured as "indoor" channel in Ecowitt)
   - Ecowitt API v3 access (free, request at ecowitt.net)
3. **Google Account** for Apps Script and Sheets
4. **Notification service** (at least one):
   - [Twilio](https://www.twilio.com) account (WhatsApp sandbox + SMS)
   - [SMSAPI.pl](https://www.smsapi.pl) account (or adapt `sendSMSAlert()` for your SMS provider)
5. **[clasp](https://github.com/nicholaiii/clasp)** CLI (optional, for deployment from command line)

## Setup Guide

### 1. Create Google Apps Script Project

1. Go to [script.google.com](https://script.google.com) and create a new project
2. Create a new Google Spreadsheet and link it to the script (the script uses `SpreadsheetApp.getActiveSpreadsheet()`)
3. In the spreadsheet, create these sheets (tabs):

| Sheet Name | Columns | Purpose |
|---|---|---|
| `frost_risk` | Time, OutdoorTemp, GroundTemp, FrostFlag | Frost risk log |
| `vineyard_temp_humidity` | Time, TempC, Humidity%, Precip, Source | Vineyard climate data |
| `solar_uv` | Time, UV, Radiation | Solar/UV index |
| `rainfall` | Time, Rate, Daily, Weekly, Monthly, Yearly | Rainfall data |
| `wind` | Time, AvgSpeed, MinSpeed, MaxSpeed, MaxGust, CurrentSpeed, CurrentGust, Direction, Note | Wind data |
| `pressure` | Time, Relative, Absolute | Atmospheric pressure |
| `powdery_mildew_risk` | Time, Temp, Humidity, Precip, Source, Risk | Mildew risk tracking |
| `sprinkler_status` | Date, ZoneID, Runs, TotalMinutes, EstimatedLiters | Daily sprinkler summary |

### 2. Copy Code

Copy the contents of `Code.js` into the script editor (replace the default `Code.gs` content). Google Apps Script uses `.gs` extension in the editor, but `clasp` uses `.js` -- both work.

### 3. Set Script Properties

Go to **Project Settings** (gear icon) > **Script Properties** and add:

| Property | Description | Example |
|---|---|---|
| `ECOWITT_APPLICATION_KEY` | Your Ecowitt application key | `abc123...` |
| `ECOWITT_API_KEY` | Your Ecowitt API key | `def456...` |
| `ECOWITT_MAC` | MAC address of your weather station | `AA:BB:CC:DD:EE:FF` |
| `OPENSPRINKLER_OTC` | OpenSprinkler cloud token (from OS admin panel) | `abcdef1234` |
| `OPENSPRINKLER_PASSWORD` | OpenSprinkler password (plain text -- hashed with MD5 in code) | `mypassword` |
| `PANEL_SECRET` | Secret token for authenticated panel actions | `any-random-string` |
| `SMSAPI_TOKEN` | SMSAPI.pl access token (optional) | `token123` |
| `SMSAPI_RECIPIENTS` | SMS recipient numbers, comma-separated (optional) | `+48123456789` |
| `TWILIO_SID` | Twilio Account SID (optional) | `AC...` |
| `TWILIO_AUTH` | Twilio Auth Token (optional) | `auth...` |
| `TWILIO_TO` | Your phone number for notifications | `+48123456789` |
| `TWILIO_WHATSAPP_FROM` | Twilio WhatsApp sender (optional) | `whatsapp:+14155238886` |
| `TWILIO_SMS_FROM` | Twilio SMS sender number (optional) | `+19876543210` |

**Note:** You need at least one notification method (SMSAPI or Twilio). The system uses a fallback chain: WhatsApp -> Twilio SMS -> SMSAPI.pl.

### 4. Deploy as Web App

1. Click **Deploy** > **New deployment**
2. Select type: **Web app**
3. Set:
   - Execute as: **Me**
   - Who has access: **Anyone** (needed for the panel to work without Google auth)
4. Click **Deploy** and copy the web app URL

### 5. Set Up Triggers

Go to **Triggers** (clock icon on the left) and create:

| Function | Event type | Interval | Purpose |
|---|---|---|---|
| `getWeatherToSheet` | Time-driven | Every 15 minutes | Main loop: fetch weather, log data, monitor frost |
| `logDailySprinklerSummary` | Time-driven | Daily (e.g., 6:00 AM) | Daily sprinkler run summary |

**Do NOT manually create triggers for `runLawnWatering`** -- the system creates/removes lawn triggers automatically when switching modes.

### 6. Test with Control Panel

1. Open `panel.html` in a text editor
2. Replace `YOUR_DEPLOYED_WEB_APP_URL_HERE` with your actual deployed URL
3. Open the HTML file in a browser
4. Click **Refresh** to verify status is returned
5. Enter your `PANEL_SECRET` token and test mode switching

## Configuration

All configuration is at the top of `Code.js`. Key parameters to customize:

### Frost Protection

```javascript
const FROST_LOOP_START_THRESHOLD = 2;          // Start if ground temp < 2C + falling trend
const FROST_LOOP_ABSOLUTE_START_THRESHOLD = 0.5; // Always start if ground temp < 0.5C
const FROST_LOOP_STOP_THRESHOLD = 3;           // Stop when ground temp >= 3C
```

### Zone Pairs

```javascript
// Customize to match your zone layout and water pressure capacity
const FROST_PAIRS = [[1, 2], [3, 4], [5, 6]];  // Pairs of zones
const FROST_PAIR_DURATION_SECONDS = 180;         // 3 minutes per pair
const FROST_PAIR_GAP_SECONDS = 15;               // Gap between pairs
```

### Lawn Irrigation

```javascript
const LAWN_ZONES = [5, 6, 8, 9, 10, 12];   // Which zones to water
const LAWN_DURATION_MINUTES = 20;             // Minutes per zone
const LAWN_START_HOUR = 1;                    // 1:00 AM daily
```

### Frost Season Calendar

The system only monitors for frost during a configurable season (default: April 1 -- June 14). Outside this window, frost monitoring is disabled unless you enable the manual override.

To change the season, modify the condition in `monitorFrostRiskAuto()`:

```javascript
// month is 0-indexed: 3=April, 5=June
const outsideCalendarSeason = (month > 5 || month < 3 || (month === 5 && day >= 15));
```

### Sprinkler Flow Rate

For water usage estimates in the daily summary:

```javascript
const FLIPPERS_PER_ZONE = 24;       // Sprinkler heads per zone
const FLIPPER_FLOW_RATE_LPH = 43;   // Liters per hour per head
```

## How the Frost Protection Algorithm Works

1. **Every 15 minutes**, `getWeatherToSheet()` runs:
   - Fetches weather data from Ecowitt API
   - Logs all weather parameters to respective sheets
   - Calls `monitorFrostRiskAuto()` for frost decision logic

2. **`monitorFrostRiskAuto()`** checks:
   - Is the system in FROST mode? (If LAWN mode, only sends frost warnings)
   - Is it within frost season? (Calendar check + manual override)
   - Gets the last N ground temperature readings from the spreadsheet
   - Checks for a consistently falling temperature trend

3. **Decision matrix:**

| Ground Temp | Trend | Loop Status | Action |
|---|---|---|---|
| < 0.5C | Any | Inactive | **START** loop (absolute threshold) |
| < 2C | Falling | Inactive | **START** loop (trend-based) |
| >= 3C | Any | Active | **STOP** loop |
| < 3C | Any | Active | **CONTINUE** loop (restart cycle) |

4. **Frost pair cycle:**
   - Pairs run sequentially: S01+S02 (3 min) -> 15s gap -> S03+S04 (3 min) -> 15s gap -> S05+S06 (3 min)
   - After the last pair, a 4-minute recheck timer starts
   - On recheck, the system re-evaluates temperature and either starts another cycle or stops

5. **Notifications:**
   - SMS + WhatsApp on loop START (critical -- sent via both channels)
   - WhatsApp on loop STOP
   - WhatsApp on frost trend detection (early warning)
   - WhatsApp on sensor malfunction (unreasonable readings)

## Web API Reference

The deployed web app exposes these endpoints:

| Action | Auth | Method | Description |
|---|---|---|---|
| `?action=status` | No | GET | System status, active zones, mode |
| `?action=programs` | No | GET | List OpenSprinkler programs |
| `?action=runZones&zones=1,2&duration=60` | No | GET | Manually run zones (testing) |
| `?action=switchToFrost&token=X` | Yes | GET | Switch to frost mode |
| `?action=switchToLawn&token=X` | Yes | GET | Switch to lawn mode |
| `?action=startFrostLoop&token=X` | Yes | GET | Manually start frost loop |
| `?action=stopAll&token=X` | Yes | GET | Emergency stop all |
| `?action=testLawn&token=X` | Yes | GET | Run lawn watering once |
| `?action=stopLawn&token=X` | Yes | GET | Stop lawn watering |
| `?action=enableFrostSeason&token=X` | Yes | GET | Enable frost season override |
| `?action=disableFrostSeason&token=X` | Yes | GET | Disable frost season override |
| `?action=irrigateVineyard&minutes=10` | No | GET | Irrigate vineyard in pairs |
| `?action=stopIrrigate` | No | GET | Stop vineyard irrigation |

**Example:**
```bash
# Get status
curl "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec?action=status"

# Switch to frost mode
curl "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec?action=switchToFrost&token=YOUR_SECRET"
```

## Troubleshooting

### No weather data
- Check that `ECOWITT_APPLICATION_KEY`, `ECOWITT_API_KEY`, and `ECOWITT_MAC` are correct in Script Properties
- Verify your Ecowitt API access at [api.ecowitt.net](https://api.ecowitt.net)
- Check Apps Script execution logs (Executions tab)

### OpenSprinkler not responding
- Verify `OPENSPRINKLER_OTC` is correct (find it in your OS admin panel under Cloud settings)
- Make sure `OPENSPRINKLER_PASSWORD` matches your OS admin password
- Test manually: `?action=runZones&zones=1&duration=10` should activate zone 1 for 10 seconds

### Frost loop not starting
- Check that `SYSTEM_MODE` is set to `frost` (use status endpoint)
- Verify you are within the frost season calendar window, or enable manual override
- Check the `frost_risk` sheet has enough data rows (minimum 3 readings)
- Check Apps Script logs for `monitorFrostRiskAuto` output

### SMS/WhatsApp not arriving
- Verify Twilio credentials in Script Properties
- For WhatsApp sandbox: you must first send the join message from your phone to the sandbox number
- Sandbox sessions expire after 72 hours of inactivity -- the `keepAliveSandbox()` function handles this
- Check Twilio dashboard for delivery status

### Google Apps Script execution limits
- GAS has a 6-minute execution time limit per function call
- Lawn watering uses chained triggers to work around this (each zone scheduled as separate execution)
- If you see "Exceeded maximum execution time" errors, this is normal -- the trigger chain handles it

## Adapting for Your Setup

This system was originally built for a vineyard in Poland, but can be adapted for any frost-sensitive crops:

1. **Change zone pairs** -- adjust `FROST_PAIRS` to match your zone layout and water pressure
2. **Change thresholds** -- the default 0.5C/2C/3C thresholds work well for grapevines in Central Europe; adjust for your climate and crops
3. **Change frost season** -- modify the calendar check in `monitorFrostRiskAuto()` for your region's frost risk window
4. **Change notification provider** -- replace `sendSMSAlert()` with your preferred SMS API, or remove SMS entirely and rely only on Twilio
5. **Change weather station** -- if not using Ecowitt, replace `fetchWeatherData()` with your weather API; keep the same data structure or adapt the logging functions
6. **Add/remove weather logging** -- the weather logging functions (rainfall, wind, pressure, etc.) are independent and can be removed if not needed

## Using clasp for Deployment

If you prefer command-line deployment:

```bash
# Install clasp
npm install -g @google/clasp

# Login to Google
clasp login

# Clone your script (or create new)
clasp clone YOUR_SCRIPT_ID

# Copy .clasp.json.example to .clasp.json and set your script ID
cp .clasp.json.example .clasp.json

# Push code
clasp push

# Deploy new version
clasp deploy --description "v1.0"
```

## License

MIT License. See [LICENSE](LICENSE) for details.

## Acknowledgments

- [OpenSprinkler](https://opensprinkler.com) by Ray Wang -- excellent open-source irrigation controller
- [Ecowitt](https://www.ecowitt.com) -- affordable and reliable weather stations with open API
- The frost protection by sprinkler irrigation technique is well-documented in viticulture literature; this system automates the manual process
