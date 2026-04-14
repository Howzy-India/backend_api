import { google } from "googleapis";
import type { ProjectResponse } from "../types/project";

// Column order matches the original CSV spec (39 columns)
function toSheetRow(p: ProjectResponse): string[] {
  const configs = p.configurations
    .map((c) => `${c.bhkCount}(${c.minSft}-${c.maxSft}sft)`)
    .join("; ");
  const unitDetail = p.configurations
    .map((c) => `${c.bhkCount}: ${c.unitCount}`)
    .join(", ");

  return [
    p.uniqueId ?? "",                           // A: Property ID
    p.developerName ?? "",                      // B: Builder Name
    p.name ?? "",                               // C: Project Name
    p.reraNumber ?? "",                         // D: RERA No
    p.possessionStatus ?? "",                   // E: Possession Status
    p.possessionDate ?? "",                     // F: Possession Month/Year
    p.projectSegment ?? "",                     // G: Segment
    p.projectType ?? "",                        // H: Type
    p.landParcel != null ? String(p.landParcel) : "",   // I: Land Parcel (Acres)
    p.numberOfTowers != null ? String(p.numberOfTowers) : "", // J: No. Towers
    p.totalUnits != null ? String(p.totalUnits) : "",   // K: No. Units
    p.density ?? "",                            // L: Density
    configs,                                    // M: Configurations
    unitDetail,                                 // N: Units in Detail
    p.sftCostingPerSqft != null ? String(p.sftCostingPerSqft) : "", // O: SFT Costing
    p.emiStartsFrom ?? "",                      // P: EMI Starts From
    p.pricing?.twoBhk != null ? String(p.pricing.twoBhk) : "",   // Q: 2BHK Price
    p.pricing?.threeBhk != null ? String(p.pricing.threeBhk) : "", // R: 3BHK Price
    p.pricing?.fourBhk != null ? String(p.pricing.fourBhk) : "",  // S: 4BHK Price
    p.amenities.join(", "),                     // T: Amenities
    p.usp ?? "",                                // U: Project USP
    p.photos.join(", "),                        // V: Project Photos
    p.videoLink3D ?? "",                        // W: 3D Video Link
    p.brochureLink ?? "",                       // X: Brochure PDF Link
    p.availableUnits != null ? String(p.availableUnits) : "", // Y: Available Units
    p.projectManager?.name ?? "",              // Z: Project Manager Name
    p.projectManager?.contact ?? "",           // AA: Project Manager Number
    p.spoc?.name ?? "",                        // AB: SPOC Name
    p.spoc?.contact ?? "",                     // AC: SPOC Number
    p.onboardingAgreementLink ?? "",           // AD: Onboarding Agreement
    p.address ?? "",                           // AE: Full Address
    p.zone ?? "",                              // AF: Zone
    p.location ?? "",                          // AG: Cluster/Location
    p.area ?? "",                              // AH: Area
    p.city ?? "",                              // AI: City
    p.state ?? "",                             // AJ: State
    p.pincode ?? "",                           // AK: Pincode
    p.landmark ?? "",                          // AL: Landmark
    p.mapLink ?? "",                           // AM: Google Maps Pin
  ];
}

const SHEET_HEADERS = [
  "Property ID", "Builder Name", "Project Name", "RERA No",
  "Possession Status", "Possession Month/Year", "Segment", "Type",
  "Land Parcel (Acres)", "No. Towers", "No. Units", "Density",
  "Configurations", "Units in Detail", "SFT Costing (₹/sqft)",
  "EMI Starts From", "2BHK Price", "3BHK Price", "4BHK Price",
  "Amenities", "Project USP", "Project Photos", "3D Video Link",
  "Brochure PDF Link", "Available Units", "Proj Mgr Name", "Proj Mgr Number",
  "SPOC Name", "SPOC Number", "Onboarding Agreement", "Full Address",
  "Zone", "Cluster/Location", "Area", "City", "State", "Pincode",
  "Landmark", "Google Maps Pin",
];

async function getSheetsClient() {
  // Use Application Default Credentials (ADC) — works automatically inside Cloud Functions
  // via the compute service account. No JSON key needed.
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

async function ensureHeaderRow(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string
): Promise<void> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Sheet1!A1",
  });

  const firstCell: string = res.data.values?.[0]?.[0] ?? "";

  // Headers already present — nothing to do
  if (firstCell === SHEET_HEADERS[0]) return;

  if (!firstCell) {
    // Sheet is empty — write headers at A1
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "Sheet1!A1",
      valueInputOption: "RAW",
      requestBody: { values: [SHEET_HEADERS] },
    });
  } else {
    // Data exists at row 1 but no header row — insert a blank row at the top
    // then write headers into it so existing data rows shift down by 1
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: {
        requests: [
          {
            insertDimension: {
              range: {
                sheetId: 0,
                dimension: "ROWS",
                startIndex: 0,
                endIndex: 1,
              },
              inheritFromBefore: false,
            },
          },
        ],
      },
    });
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: "Sheet1!A1",
      valueInputOption: "RAW",
      requestBody: { values: [SHEET_HEADERS] },
    });
  }
}

async function findRowByUniqueId(
  sheets: ReturnType<typeof google.sheets>,
  spreadsheetId: string,
  uniqueId: string
): Promise<number | null> {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: "Sheet1!A:A",
  });
  const rows = res.data.values ?? [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i][0] === uniqueId) return i + 1; // 1-indexed sheet row
  }
  return null;
}

export async function upsertProjectRow(project: ProjectResponse): Promise<void> {
  const spreadsheetId = process.env.BACKUP_SHEET_ID;
  if (!spreadsheetId) {
    console.warn("[sheetsBackup] BACKUP_SHEET_ID not set — skipping backup");
    return;
  }

  try {
    const sheets = await getSheetsClient();
    await ensureHeaderRow(sheets, spreadsheetId);

    const rowData = toSheetRow(project);
    const existingRow = await findRowByUniqueId(sheets, spreadsheetId, project.uniqueId ?? "");

    if (existingRow) {
      await sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `Sheet1!A${existingRow}:AM${existingRow}`,
        valueInputOption: "RAW",
        requestBody: { values: [rowData] },
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: "Sheet1!A:AM",
        valueInputOption: "RAW",
        insertDataOption: "INSERT_ROWS",
        requestBody: { values: [rowData] },
      });
    }
  } catch (err) {
    // Fire-and-forget: log error but never block the API response
    console.error("[sheetsBackup] Failed to upsert row:", err);
  }
}
