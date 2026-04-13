// TypeScript types for the projects Cloud SQL schema

export type PropertyType = "PROJECT" | "PLOT" | "FARMLAND";
export type ProjectSegment = "PREMIUM" | "ECONOMY" | "SUPER_LUXURY";
export type ProjectType =
  | "GATED_SOCIETY"
  | "SEMI_GATED"
  | "STAND_ALONE"
  | "VILLA_COMMUNITY"
  | "ULTRA_LUXURY";
export type PossessionStatus = "RTMI" | "UNDER_CONSTRUCTION" | "EOI";
export type DensityType = "LOW_DENSITY" | "MEDIUM_DENSITY" | "HIGH_DENSITY";
export type ProjectZone = "WEST" | "EAST" | "SOUTH" | "NORTH" | "CENTRAL";
export type ProjectStatus =
  | "ACTIVE"
  | "INACTIVE"
  | "COMING_SOON"
  | "PENDING_APPROVAL";

// Raw SQL row from the `projects` table (snake_case columns)
export interface ProjectRow {
  id: string;
  unique_id: string;
  name: string;
  developer_name: string;
  rera_number: string | null;
  property_type: PropertyType;
  project_type: ProjectType | null;
  project_segment: ProjectSegment | null;
  possession_status: PossessionStatus | null;
  possession_date: string | null;
  address: string | null;
  zone: ProjectZone | null;
  location: string | null;
  area: string | null;
  city: string;
  state: string | null;
  pincode: string | null;
  landmark: string | null;
  map_link: string | null;
  land_parcel: number | null;
  number_of_towers: number | null;
  total_units: number | null;
  available_units: number | null;
  density: DensityType | null;
  sft_costing_per_sqft: number | null;
  emi_starts_from: string | null;
  pricing_two_bhk: number | null;
  pricing_three_bhk: number | null;
  pricing_four_bhk: number | null;
  video_link_3d: string | null;
  brochure_link: string | null;
  onboarding_agreement_link: string | null;
  project_manager_name: string | null;
  project_manager_contact: string | null;
  spoc_name: string | null;
  spoc_contact: string | null;
  usp: string | null;
  teaser: string | null;
  details: string | null;
  status: ProjectStatus;
  lead_registration_status: string | null;
  rejection_reason: string | null;
  created_by: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date | null;
}

export interface ConfigurationRow {
  id: string;
  project_id: string;
  bhk_count: number;
  min_sft: number;
  max_sft: number;
  unit_count: number;
}

export interface ProjectPhotoRow {
  id: string;
  project_id: string;
  url: string;
  display_order: number;
}

export interface ProjectAmenityRow {
  id: string;
  project_id: string;
  amenity: string;
}

// Camel-case API response shape
export interface ConfigurationResponse {
  id: string;
  bhkCount: number;
  minSft: number;
  maxSft: number;
  unitCount: number;
}

export interface ProjectResponse {
  id: string;
  uniqueId: string;
  name: string;
  developerName: string;
  reraNumber: string | null;
  propertyType: PropertyType;
  projectType: ProjectType | null;
  projectSegment: ProjectSegment | null;
  possessionStatus: PossessionStatus | null;
  possessionDate: string | null;
  address: string | null;
  zone: ProjectZone | null;
  location: string | null;
  area: string | null;
  city: string;
  state: string | null;
  pincode: string | null;
  landmark: string | null;
  mapLink: string | null;
  landParcel: number | null;
  numberOfTowers: number | null;
  totalUnits: number | null;
  availableUnits: number | null;
  density: DensityType | null;
  sftCostingPerSqft: number | null;
  emiStartsFrom: string | null;
  pricing: {
    twoBhk: number | null;
    threeBhk: number | null;
    fourBhk: number | null;
  };
  videoLink3D: string | null;
  brochureLink: string | null;
  onboardingAgreementLink: string | null;
  projectManager: { name: string | null; contact: string | null };
  spoc: { name: string | null; contact: string | null };
  usp: string | null;
  teaser: string | null;
  details: string | null;
  status: ProjectStatus;
  leadRegistrationStatus: string | null;
  rejectionReason: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  configurations: ConfigurationResponse[];
  photos: string[];
  amenities: string[];
}

// Input for creating a project (from request body)
export interface CreateProjectInput {
  name: string;
  developerName: string;
  propertyType: PropertyType;
  reraNumber?: string;
  projectType?: ProjectType;
  projectSegment?: ProjectSegment;
  possessionStatus?: PossessionStatus;
  possessionDate?: string;
  address?: string;
  zone?: ProjectZone;
  location?: string;
  area?: string;
  city: string;
  state?: string;
  pincode?: string;
  landmark?: string;
  mapLink?: string;
  landParcel?: number;
  numberOfTowers?: number;
  totalUnits?: number;
  availableUnits?: number;
  density?: DensityType;
  sftCostingPerSqft?: number;
  emiStartsFrom?: string;
  pricingTwoBhk?: number;
  pricingThreeBhk?: number;
  pricingFourBhk?: number;
  videoLink3D?: string;
  brochureLink?: string;
  onboardingAgreementLink?: string;
  projectManagerName?: string;
  projectManagerContact?: string;
  spocName?: string;
  spocContact?: string;
  usp?: string;
  teaser?: string;
  details?: string;
  status?: ProjectStatus;
  configurations?: Array<{
    bhkCount: number;
    minSft: number;
    maxSft: number;
    unitCount: number;
  }>;
  photos?: string[];
  amenities?: string[];
}

export type UpdateProjectInput = Partial<CreateProjectInput>;
