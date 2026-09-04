// NOTE: engine copy of `search/shared/schemas/vehicle-ad.ts`. Ported verbatim so
// the ingestion-pipeline validates car ads against the SAME permissive zod
// contract the engine does.
import { z } from "zod";

/**
 * The scraped-car ad shape the vehicle extractor produces (camelCase in), which
 * ingest maps into the `vehicle_ads` row (snake_case out). Deliberately
 * PERMISSIVE: classification/spec fields are free strings (normalized at
 * row-build time, not rejected) so a real listing is never dropped over an
 * unexpected enum value like "Benzyna" or "Automatik" — the only hard rule is
 * "it's an object". Mirrors `property-ad.ts` for the property vertical.
 */

const num = z.number().finite().nullish();
const str = z.string().trim().min(1).nullish();
const bool = z.boolean().nullish();

export const vehicleAddressSchema = z
  .object({
    street: str,
    houseNumber: str,
    postalCode: str,
    city: str,
    state: str,
    country: str,
    displayName: str,
    coordinates: z.object({ lat: z.number(), lon: z.number() }).partial().nullish()
  })
  .partial()
  .passthrough();

export const vehiclePriceSchema = z
  .object({
    amount: num,
    currency: str,
    net: num,
    vatDeductible: bool,
    onRequest: bool,
    monthlyRate: num,
    downPayment: num,
    contractMonths: num,
    annualMileageLimitKm: num
  })
  .partial()
  .passthrough();

export const vehicleImageSchema = z.union([z.string(), z.object({ url: z.string() }).passthrough()]);

/** A seller contact — dealer/agency or individual (mirrors the property agent shape). */
export const vehicleContactSchema = z
  .object({
    name: str,
    image: str,
    phoneNumber: str,
    emailAddress: str,
    website: str,
    address: vehicleAddressSchema.nullish()
  })
  .partial()
  .passthrough();

/** Who is selling the car — the generic agency/agent pair, like real estate. */
export const vehicleAgentSchema = z
  .object({
    agency: vehicleContactSchema.nullish(),
    agent: vehicleContactSchema.nullish()
  })
  .partial()
  .passthrough();

export const vehicleAdSchema = z
  .object({
    // identity
    title: str,
    description: str,
    make: str,
    model: str,
    variant: str,
    vin: str,
    referenceNumber: str,
    language: str,

    // classification (free strings — normalized in the row builder)
    bodyType: str,
    listingType: str, // buy | lease | rent
    condition: str, // new | used | demo | certified
    sellerType: str, // private | dealer

    // powertrain
    fuelType: str,
    transmission: str, // automatic | manual
    drivetrain: str, // fwd | rwd | awd | 4x4
    powerHp: num,
    powerKw: num,
    engineDisplacementCc: num,
    cylinders: num,
    torqueNm: num,
    gears: num,

    // EV / hybrid
    batteryKwh: num,
    electricRangeKm: num,

    // body / interior
    doors: num,
    seats: num,
    color: str,
    interiorColor: str,
    interiorMaterial: str,
    finish: str,

    // history / condition / emissions
    year: num,
    firstRegistration: str,
    previousOwners: num,
    mileageKm: num,
    serviceBook: bool,
    accidentFree: bool,
    co2Gpkm: num,
    emissionClass: str,
    fuelConsumptionLp100: num,
    electricConsumptionKwhp100: num,

    // pricing / leasing
    price: vehiclePriceSchema.nullish(),

    // location
    address: vehicleAddressSchema.nullish(),

    // seller (dealer/agency + individual), mirroring real estate
    agent: vehicleAgentSchema.nullish(),

    // equipment
    features: z.record(z.unknown()).nullish(),
    featureKeywords: z.array(z.string()).nullish(),

    // images + source
    images: z.array(vehicleImageSchema).nullish(),
    sourceUrl: str,
    sourceDomain: str,
    searchQuery: str,
    publishedAt: str,
    updatedAt: str,

    // Full listing detail page as clean Markdown (scraper-rendered). Optional
    // dense-embedding source; chunked into page_content_chunks at ingest.
    pageContent: z.string().optional().default("")
  })
  .passthrough();

export type VehicleAd = z.infer<typeof vehicleAdSchema>;
export type VehicleAddress = z.infer<typeof vehicleAddressSchema>;
