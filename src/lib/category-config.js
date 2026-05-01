// One shared category map keeps the app consistent.
// The user sees one friendly category name, but each data source expects a
// different value: Yelp uses aliases, Google Places uses place types, and
// OpenStreetMap uses tag queries.
export const CATEGORY_CONFIG = {
  restaurants: {
    label: "Restaurants",
    yelpAlias: "restaurants",
    googlePlacesTypes: ["restaurant"],
    openStreetMapQueries: [
      'node["amenity"="restaurant"]',
      'way["amenity"="restaurant"]',
    ],
  },
  barbershops: {
    label: "Barbershops",
    // Yelp has several hair-cutting categories. We ask for barber and hair
    // salon related aliases, then the backend applies an extra cleanup filter.
    yelpAlias: "barbers,hair,menshair,hairstylists,kidshairsalons",
    googlePlacesTypes: ["hair_care"],
    requiresBarbershopFilter: true,
    openStreetMapQueries: [
      'node["shop"="hairdresser"]',
      'way["shop"="hairdresser"]',
      'node["shop"="barber"]',
      'way["shop"="barber"]',
      'node["shop"="hairdresser"]["hairdresser"="barber"]',
      'way["shop"="hairdresser"]["hairdresser"="barber"]',
    ],
  },
  coffee: {
    label: "Coffee Shops",
    yelpAlias: "coffee",
    googlePlacesTypes: ["cafe"],
    openStreetMapQueries: ['node["amenity"="cafe"]', 'way["amenity"="cafe"]'],
  },
  grocery: {
    label: "Grocery Stores",
    yelpAlias: "grocery",
    googlePlacesTypes: ["grocery_store"],
    openStreetMapQueries: [
      'node["shop"="supermarket"]',
      'way["shop"="supermarket"]',
      'node["shop"="grocery"]',
      'way["shop"="grocery"]',
      'node["shop"="convenience"]',
      'way["shop"="convenience"]',
    ],
  },
  convenience: {
    label: "Convenience Stores",
    yelpAlias: "convenience",
    googlePlacesTypes: ["convenience_store"],
    openStreetMapQueries: [
      'node["shop"="convenience"]',
      'way["shop"="convenience"]',
    ],
  },
};

export const CATEGORY_OPTIONS = Object.entries(CATEGORY_CONFIG).map(
  ([value, config]) => ({
    value,
    label: config.label,
  }),
);

export function getCategoryConfig(categoryValue) {
  return CATEGORY_CONFIG[categoryValue] || null;
}
