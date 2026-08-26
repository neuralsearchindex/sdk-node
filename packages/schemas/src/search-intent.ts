export interface RetrievalWeights {
  dense: number;
  sparse: number;
  image: number;
}

export interface SearchIntent {
  location: {
    city: string | null;
    region: string | null;
    country: string | null;
  };
  listingType: "rent" | "buy" | null;
  propertyType: string | null;
  priceMin: number | null;
  priceMax: number | null;
  currency: string | null;
  bedroomsMin: number | null;
  roomsMin: number | null;
  denseVectorSearchText: string;
  sparseVectorSearchText: string;
  imageSearchText: string;
  displayChips: string[];
  resultTarget: number;
  retrievalWeights: RetrievalWeights;
}
