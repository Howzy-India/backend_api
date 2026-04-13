import { toISODate, coerceDetails } from "./helpers";
import type {
  ProjectRow,
  ConfigurationRow,
  ProjectPhotoRow,
  ProjectAmenityRow,
  ProjectResponse,
} from "../types/project";

// ── SQL row → API response mapper ────────────────────────────────────────────
export const mapProjectRow = (
  row: ProjectRow & {
    configurations?: ConfigurationRow[];
    photos?: ProjectPhotoRow[];
    amenities?: ProjectAmenityRow[];
  }
): ProjectResponse => ({
  id: row.id,
  uniqueId: row.unique_id,
  name: row.name,
  developerName: row.developer_name,
  reraNumber: row.rera_number,
  propertyType: row.property_type,
  projectType: row.project_type,
  projectSegment: row.project_segment,
  possessionStatus: row.possession_status,
  possessionDate: row.possession_date,
  address: row.address,
  zone: row.zone,
  location: row.location,
  area: row.area,
  city: row.city,
  state: row.state,
  pincode: row.pincode,
  landmark: row.landmark,
  mapLink: row.map_link,
  landParcel: row.land_parcel,
  numberOfTowers: row.number_of_towers,
  totalUnits: row.total_units,
  availableUnits: row.available_units,
  density: row.density,
  sftCostingPerSqft: row.sft_costing_per_sqft,
  emiStartsFrom: row.emi_starts_from,
  pricing: {
    twoBhk: row.pricing_two_bhk,
    threeBhk: row.pricing_three_bhk,
    fourBhk: row.pricing_four_bhk,
  },
  videoLink3D: row.video_link_3d,
  brochureLink: row.brochure_link,
  onboardingAgreementLink: row.onboarding_agreement_link,
  agreementPercentage: row.agreement_percentage ?? null,
  projectManager: {
    name: row.project_manager_name,
    contact: row.project_manager_contact,
  },
  spoc: {
    name: row.spoc_name,
    contact: row.spoc_contact,
  },
  usp: row.usp,
  teaser: row.teaser,
  details: row.details,
  status: row.status,
  leadRegistrationStatus: row.lead_registration_status,
  rejectionReason: row.rejection_reason ?? null,
  createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
  updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  configurations: (row.configurations ?? []).map((c) => ({
    id: c.id,
    bhkCount: c.bhk_count,
    minSft: c.min_sft,
    maxSft: c.max_sft,
    unitCount: c.unit_count,
  })),
  photos: (row.photos ?? [])
    .sort((a, b) => a.display_order - b.display_order)
    .map((p) => p.url),
  amenities: (row.amenities ?? []).map((a) => a.amenity),
});

export const mapProjectDoc = (
  doc: FirebaseFirestore.QueryDocumentSnapshot
) => {
  const data = doc.data() || {};
  const builderPoc =
    data.builderPoc ||
    (data.builder_poc_name
      ? { name: data.builder_poc_name, contact: data.builder_poc_contact }
      : null);

  return {
    id: doc.id,
    uniqueId: data.uniqueId ?? data.unique_id ?? "",
    reraNumber: data.reraNumber ?? data.rera_number ?? "",
    name: data.name ?? "",
    developerName: data.developerName ?? data.developer_name ?? "",
    city: data.city ?? "",
    location: data.location ?? "",
    mapLink: data.mapLink ?? data.map_link ?? "",
    usp: data.usp ?? "",
    leadRegistrationStatus:
      data.leadRegistrationStatus ?? data.lead_registration_status ?? "",
    projectType: data.projectType ?? data.project_type ?? "",
    propertyType: data.propertyType ?? data.property_type ?? "project",
    projectSegment: data.projectSegment ?? data.project_segment ?? "",
    possession: data.possession ?? "",
    availability: data.availability ?? null,
    builderPoc,
    status:
      data.status ??
      data.projectStatus ??
      data.leadRegistrationStatus ??
      "Listed",
    teaser: data.teaser ?? "",
    details: data.details ?? "",
    createdAt: toISODate(data.created_at ?? data.createdAt),
  };
};

export const mapSubmissionDoc = (
  doc: FirebaseFirestore.QueryDocumentSnapshot
) => {
  const data = doc.data() || {};
  return {
    id: doc.id,
    type: (data.type ?? "") as string,
    name: (data.name ?? "") as string,
    email: (data.email ?? "") as string,
    status: (data.status ?? "Pending") as string,
    details: coerceDetails(data.details),
    createdAt: toISODate(data.created_at ?? data.createdAt),
  };
};

export const submissionToProperty = (
  submission: ReturnType<typeof mapSubmissionDoc>
) => {
  const details = submission.details || {};
  let propertyType = "project";
  if (submission.type === "Farm Land") propertyType = "farmland";
  if (submission.type === "Plot") propertyType = "plot";
  if (submission.type === "Project") propertyType = "project";

  return {
    id: submission.id,
    uniqueId: details.uniqueId ?? submission.id,
    reraNumber: details.reraNumber ?? "",
    name: submission.name,
    developerName: details.developerName ?? submission.name,
    city: details.city ?? "",
    location: details.location ?? details.city ?? "",
    mapLink: details.mapLink ?? "",
    usp: details.description ?? details.usp ?? "",
    leadRegistrationStatus: submission.status ?? "Registered",
    projectType: submission.type,
    propertyType,
    projectSegment:
      details.projectSegment ?? details.price ?? details.budget ?? "",
    possession: details.possession ?? "",
    availability: details.availability ?? null,
    builderPoc: details.builderPoc ?? {
      name: submission.name,
      contact: details.contact ?? submission.email,
    },
    status: details.status ?? submission.status ?? "Registered",
    teaser: details.teaser ?? "",
    details: details.details ?? details.description ?? "",
    createdAt: submission.createdAt,
  };
};

export const mapResaleDoc = (
  doc: FirebaseFirestore.QueryDocumentSnapshot
) => {
  const data = doc.data() || {};
  return {
    id: doc.id,
    title: (data.title ?? "") as string,
    description: (data.description ?? "") as string,
    price: (data.price ?? 0) as number,
    propertyType: (data.propertyType ?? "") as string,
    city: (data.city ?? "") as string,
    location: (data.location ?? "") as string,
    mapLink: (data.mapLink ?? null) as string | null,
    area: (data.area ?? "") as string,
    bedrooms: (data.bedrooms ?? null) as number | null,
    bathrooms: (data.bathrooms ?? null) as number | null,
    floor: (data.floor ?? null) as number | null,
    totalFloors: (data.totalFloors ?? null) as number | null,
    amenities: (data.amenities ?? []) as string[],
    possession: (data.possession ?? null) as string | null,
    images: (data.images ?? []) as string[],
    submittedBy: (data.submittedBy ?? "") as string,
    submittedByUid: (data.submittedByUid ?? "") as string,
    submittedByRole: (data.submittedByRole ?? "client") as string,
    status: (data.status ?? "Pending") as string,
    remarks: (data.remarks ?? null) as string | null,
    approvedBy: (data.approvedBy ?? null) as string | null,
    approvedAt: toISODate(data.approvedAt),
    createdAt: toISODate(data.created_at ?? data.createdAt),
    updatedAt: toISODate(data.updated_at ?? data.updatedAt),
    builderName: (data.builderName ?? null) as string | null,
    projectName: (data.projectName ?? null) as string | null,
    segment: (data.segment ?? null) as string | null,
    societyType: (data.societyType ?? null) as string | null,
    landParcel: (data.landParcel ?? null) as string | null,
    numberOfTowers: (data.numberOfTowers ?? null) as number | null,
    numberOfUnits: (data.numberOfUnits ?? null) as number | null,
    density: (data.density ?? null) as string | null,
    emiFrom: (data.emiFrom ?? null) as string | null,
    floorPlan: (data.floorPlan ?? null) as string | null,
    ownerName: (data.ownerName ?? null) as string | null,
    ownerPhone: (data.ownerPhone ?? null) as string | null,
    agentName: (data.agentName ?? null) as string | null,
    agentPhone: (data.agentPhone ?? null) as string | null,
    address: (data.address ?? null) as string | null,
    zone: (data.zone ?? null) as string | null,
    cluster: (data.cluster ?? null) as string | null,
    state: (data.state ?? null) as string | null,
    pincode: (data.pincode ?? null) as string | null,
    landmark: (data.landmark ?? null) as string | null,
  };
};

export const mapLeadDoc = (doc: FirebaseFirestore.QueryDocumentSnapshot) => {
  const data = doc.data() || {};
  const locationPreferred =
    data.locationPreferred ?? data.location_preferred ?? "";
  const lookingBhk = data.lookingBhk ?? data.looking_bhk ?? "";
  const documentUploaded = Boolean(
    data.document_uploaded ?? data.documentUploaded
  );

  return {
    id: doc.id,
    name: data.name ?? "",
    budget: data.budget ?? "",
    location_preferred: locationPreferred,
    locationPreferred,
    looking_bhk: lookingBhk,
    lookingBhk,
    contact: data.contact ?? "",
    milestone: data.milestone ?? "",
    project_id: data.project_id ?? data.projectId ?? "",
    projectId: data.project_id ?? data.projectId ?? "",
    document_uploaded: documentUploaded,
    documentUploaded,
    assigned_to: data.assigned_to ?? "Unassigned",
    campaign_source: data.campaign_source ?? data.campaignSource ?? "",
    campaignSource: data.campaign_source ?? data.campaignSource ?? "",
    campaign_name: data.campaign_name ?? data.campaignName ?? "",
    campaignName: data.campaign_name ?? data.campaignName ?? "",
    status: data.status ?? "New",
    followUpDate: data.followUpDate ?? null,
    followUpNote: data.followUpNote ?? null,
    created_at: toISODate(data.created_at ?? data.createdAt),
    createdAt: toISODate(data.created_at ?? data.createdAt),
  };
};

export const mapEnquiryDoc = (
  doc: FirebaseFirestore.QueryDocumentSnapshot
) => {
  const data = doc.data() || {};
  return {
    id: doc.id,
    client_name: data.client_name ?? "",
    clientName: data.client_name ?? data.clientName ?? "",
    phone: data.phone ?? "",
    email: data.email ?? "",
    property_id: data.property_id ?? data.propertyId ?? "",
    propertyId: data.property_id ?? data.propertyId ?? "",
    property_name: data.property_name ?? data.propertyName ?? "",
    propertyName: data.property_name ?? data.propertyName ?? "",
    property_type: data.property_type ?? data.propertyType ?? "",
    propertyType: data.property_type ?? data.propertyType ?? "",
    location: data.location ?? "",
    enquiry_type: data.enquiry_type ?? data.enquiryType ?? "",
    enquiryType: data.enquiry_type ?? data.enquiryType ?? "",
    source: data.source ?? "",
    status: data.status ?? "New",
    priority: data.priority ?? null,
    assigned_to: data.assigned_to ?? "",
    assigned_sales_id: data.assigned_sales_id ?? null,
    assigned_sales_name: data.assigned_sales_name ?? null,
    assigned_partner_id: data.assigned_partner_id ?? null,
    assigned_partner_name: data.assigned_partner_name ?? null,
    admin_notes: data.admin_notes ?? null,
    created_at: toISODate(data.created_at ?? data.createdAt),
    updated_at: toISODate(data.updated_at ?? data.updatedAt),
  };
};

export const mapBookingDoc = (
  doc: FirebaseFirestore.QueryDocumentSnapshot
) => {
  const data = doc.data() || {};
  return {
    id: doc.id,
    clientName: data.client_name ?? data.clientName ?? "",
    propertyName: data.property_name ?? data.propertyName ?? "",
    ticketValue: data.ticket_value ?? data.ticketValue ?? 0,
    invoiceStage: data.invoice_stage ?? data.invoiceStage ?? "",
    currency: data.currency ?? "INR",
    createdAt: toISODate(data.created_at ?? data.createdAt),
  };
};

export const mapLoginDoc = (doc: FirebaseFirestore.QueryDocumentSnapshot) => {
  const data = doc.data() || {};
  return {
    id: doc.id,
    email: data.email,
    phone: data.phone ?? null,
    device_type: data.device_type ?? data.deviceType ?? "Unknown",
    deviceType: data.device_type ?? data.deviceType ?? "Unknown",
    browser: data.browser ?? "Unknown",
    ip_address: data.ip_address ?? data.ipAddress ?? "Unknown",
    location: data.location ?? "Unknown",
    status: data.status ?? "Success",
    failure_reason: data.failure_reason ?? data.failureReason ?? null,
    login_time: toISODate(
      data.login_time ?? data.loginTime ?? data.created_at
    ),
    logout_time: toISODate(data.logout_time ?? data.logoutTime ?? null),
  };
};

export const mapUserDoc = (doc: FirebaseFirestore.QueryDocumentSnapshot) => {
  const data = doc.data() || {};
  return {
    id: doc.id,
    name: data.name ?? "",
    email: data.email ?? "",
    role: data.role ?? "",
    region: data.region ?? data.location ?? "",
    location: data.location ?? "",
    expertise: data.expertise ?? "Residential",
    activeLeads: data.activeLeads ?? data.active_leads ?? 0,
    createdAt: toISODate(data.created_at ?? data.createdAt),
  };
};
