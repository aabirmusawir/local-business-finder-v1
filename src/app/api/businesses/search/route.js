import { getCategoryConfig } from "@/lib/category-config";

const YELP_SEARCH_URL = "https://api.yelp.com/v3/businesses/search";
const GOOGLE_PLACES_SEARCH_URL =
  "https://places.googleapis.com/v1/places:searchNearby";
const GOOGLE_PLACES_FIELD_MASK =
  "places.displayName,places.formattedAddress,places.location,places.nationalPhoneNumber,places.rating,places.userRatingCount,places.googleMapsUri,places.types";
const OPENSTREETMAP_SEARCH_URL = "https://nominatim.openstreetmap.org/search";
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const SEARCH_RADIUS_IN_METERS = 32187;
const CHAIN_BLACKLIST = [
  "McDonald's",
  "Starbucks",
  "Subway",
  "Burger King",
  "Wendy's",
  "Taco Bell",
  "Chipotle",
  "Panera",
  "Dunkin",
  "Buffalo Wild Wings",
  "Applebee's",
  "Chili's",
  "Walmart",
  "Target",
  "Costco",
  "Great Clips",
  "Supercuts",
  "7-Eleven",
  "7 Eleven",
  "Speedway",
  "Circle K",
  "BP",
  "Shell",
  "Mobil",
  "Exxon",
  "Marathon",
  "Sunoco",
  "Valero",
  "Citgo",
  "Amoco",
  "Kum & Go",
  "Wawa",
  "Sheetz",
  "QuikTrip",
  "Kwik Trip",
  "Casey's",
  "Dollar General",
  "Family Dollar",
  "Dollar Tree",
  "CVS",
  "Walgreens",
  "Rite Aid",
];

const BARBERSHOP_NAME_TERMS = [
  "barber",
  "barbers",
  "barbershop",
  "barber shop",
  "cut",
  "cuts",
  "fade",
  "fades",
  "grooming",
  "hair",
  "haircut",
  "haircuts",
  "salon",
  "hair studio",
  "hair lounge",
];
const BARBERSHOP_CATEGORY_TERMS = [
  "barber",
  "hair_care",
  "hair care",
  "hairdresser",
  "salon",
];
const BARBERSHOP_EXCLUDE_TERMS = [
  "beauty supply",
  "cosmetics",
  "cosmetic",
  "makeup",
  "nails",
  "nail salon",
  "spa",
  "lashes",
  "brows",
  "waxing",
  "skincare",
  "skin care",
  "perfume",
  "fragrance",
  "wig store",
];
const BARBERSHOP_STRONG_NAME_TERMS = [
  "barber",
  "barbers",
  "barbershop",
  "barber shop",
  "hair salon",
];

const NORMALIZED_CHAIN_BLACKLIST = CHAIN_BLACKLIST.map(normalizeChainName);

// This file creates a backend API route at /api/businesses/search.
// Code in this file runs on the Next.js server, not in the visitor's browser.
export async function GET(request) {
  // The browser sends address and category in the URL, like:
  // /api/businesses/search?address=Detroit&category=restaurants
  const { searchParams } = new URL(request.url);
  const address = searchParams.get("address")?.trim();
  const category = searchParams.get("category")?.trim();

  // Server-only environment variables are safe for private keys.
  // Because this variable is NOT named NEXT_PUBLIC_YELP_API_KEY, Next.js will
  // not bundle it into the browser JavaScript. The same idea protects the
  // Google Places key because it also does not start with NEXT_PUBLIC_.
  const yelpApiKey = process.env.YELP_API_KEY?.trim();
  const googlePlacesApiKey = process.env.GOOGLE_PLACES_API_KEY?.trim();

  if (!address || !category) {
    return Response.json(
      { error: "Please provide both an address and a category." },
      { status: 400 },
    );
  }

  const categoryConfig = getCategoryConfig(category);

  if (!categoryConfig) {
    return Response.json(
      { error: "Please choose a supported category." },
      { status: 400 },
    );
  }

  const yelpSearch = searchYelp(address, categoryConfig, yelpApiKey);
  const geocodeResult = await geocodeAddress(address);

  const [yelpResult, googlePlacesResult, openStreetMapResult] =
    await Promise.all([
      yelpSearch,
      searchGooglePlaces(
        categoryConfig,
        googlePlacesApiKey,
        geocodeResult,
      ),
      searchOpenStreetMap(categoryConfig, geocodeResult),
    ]);

  const businesses = applyChainDetection([
    ...yelpResult.businesses,
    ...googlePlacesResult.businesses,
    ...openStreetMapResult.businesses,
  ]).map(removeInternalBusinessFields);
  const warnings = [
    yelpResult.warning,
    googlePlacesResult.warning,
    openStreetMapResult.warning,
  ].filter(Boolean);

  if (businesses.length === 0 && warnings.length > 0) {
    return Response.json(
      {
        error: "No source could complete this search.",
        warnings,
        sourceStatus: {
          yelp: yelpResult.status,
          googlePlaces: googlePlacesResult.status,
          openStreetMap: openStreetMapResult.status,
        },
      },
      { status: 502 },
    );
  }

  return Response.json({
    businesses,
    warnings,
    sourceStatus: {
      yelp: yelpResult.status,
      googlePlaces: googlePlacesResult.status,
      openStreetMap: openStreetMapResult.status,
    },
  });
}

async function searchYelp(address, categoryConfig, apiKey) {
  if (!apiKey) {
    return {
      businesses: [],
      warning: "Yelp was not used because YELP_API_KEY is missing from .env.local.",
      status: "missing_key",
    };
  }

  // URLSearchParams builds a safe query string for Yelp.
  // We send the user's address as Yelp's location and limit the search to
  // about 20 miles with a 32,187 meter radius.
  const yelpSearchParams = new URLSearchParams({
    location: address,
    categories: categoryConfig.yelpAlias,
    radius: String(SEARCH_RADIUS_IN_METERS),
    limit: "20",
  });

  try {
    const yelpResponse = await fetch(
      `${YELP_SEARCH_URL}?${yelpSearchParams.toString()}`,
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          Accept: "application/json",
        },
      },
    );

    const yelpData = await yelpResponse.json().catch(() => ({}));

    if (!yelpResponse.ok) {
      // Do not send Yelp's raw error text to the browser.
      // Some authentication errors can include sensitive request details, and
      // our frontend only needs a plain, safe message.
      return {
        businesses: [],
        warning: getSafeYelpError(yelpResponse.status, yelpData, apiKey),
        status: "failed",
      };
    }

    // Yelp returns a lot of fields. We only pass the frontend the fields this
    // beginner app needs, which keeps the browser data simple and readable.
    const businesses = filterBusinessesForCategory(
      (yelpData.businesses || []).map((business) => {
        const categoryText = (business.categories || [])
          .map((category) => [category.title, category.alias].filter(Boolean).join(" "))
          .join(" ");

        return {
          name: business.name,
          category: business.categories?.[0]?.title || "Unknown category",
          sourceCategoryText: categoryText,
          address: business.location?.display_address?.join(", ") || "",
          phone: business.display_phone || business.phone || "",
          rating: business.rating,
          reviewCount: business.review_count,
          review_count: business.review_count,
          yelpUrl: business.url,
          url: business.url,
          latitude: business.coordinates?.latitude ?? null,
          longitude: business.coordinates?.longitude ?? null,
          // Yelp returns distance in meters, so the frontend can display miles.
          distanceMeters: business.distance ?? null,
          distance: business.distance ?? null,
          // This simple flag lets the frontend show or hide likely chain results.
          likely_chain: isLikelyChain(business.name),
          source: "Yelp",
        };
      }),
      categoryConfig,
    );

    return {
      businesses,
      warning: "",
      status: "ok",
    };
  } catch {
    return {
      businesses: [],
      warning: "Something went wrong while contacting Yelp.",
      status: "failed",
    };
  }
}

async function geocodeAddress(address) {
  const geocodeParams = new URLSearchParams({
    q: address,
    format: "json",
    limit: "1",
  });

  try {
    // Geocoding means turning a typed address into latitude and longitude.
    // Google Nearby Search and OpenStreetMap both need map coordinates, so we
    // do this once and share the result between those two source searches.
    const geocodeResponse = await fetch(
      `${OPENSTREETMAP_SEARCH_URL}?${geocodeParams.toString()}`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "local-business-finder-nextjs-learning-app",
        },
      },
    );

    if (!geocodeResponse.ok) {
      return {
        latitude: null,
        longitude: null,
        warning: "The address lookup service could not complete this request.",
        status: "failed",
      };
    }

    const geocodeData = await geocodeResponse.json();
    const place = geocodeData[0];

    if (!place) {
      return {
        latitude: null,
        longitude: null,
        warning: "I could not find that address in OpenStreetMap. Try adding the city and state.",
        status: "failed",
      };
    }

    return {
      latitude: Number(place.lat),
      longitude: Number(place.lon),
      warning: "",
      status: "ok",
    };
  } catch {
    return {
      latitude: null,
      longitude: null,
      warning: "Something went wrong while looking up that address.",
      status: "failed",
    };
  }
}

async function searchGooglePlaces(categoryConfig, apiKey, geocodeResult) {
  if (!apiKey) {
    return {
      businesses: [],
      warning:
        "Google Places was not used because GOOGLE_PLACES_API_KEY is missing from .env.local.",
      status: "missing_key",
    };
  }

  if (!hasCoordinates(geocodeResult)) {
    return {
      businesses: [],
      warning:
        "Google Places could not search because the address could not be converted into map coordinates.",
      status: "failed",
    };
  }

  try {
    const googleResponse = await fetch(GOOGLE_PLACES_SEARCH_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // This key is only used here on the server. The browser calls our
        // backend route, not Google directly, so the key stays private.
        "X-Goog-Api-Key": apiKey,
        // Google requires a field mask. This list asks for only the fields the
        // frontend cards need, instead of downloading every possible field.
        "X-Goog-FieldMask": GOOGLE_PLACES_FIELD_MASK,
      },
      body: JSON.stringify({
        includedTypes: categoryConfig.googlePlacesTypes,
        maxResultCount: 20,
        locationRestriction: {
          circle: {
            center: {
              latitude: geocodeResult.latitude,
              longitude: geocodeResult.longitude,
            },
            radius: SEARCH_RADIUS_IN_METERS,
          },
        },
      }),
    });

    const googleData = await googleResponse.json().catch(() => ({}));

    if (!googleResponse.ok) {
      return {
        businesses: [],
        warning: getSafeGooglePlacesError(
          googleResponse.status,
          googleData,
          apiKey,
        ),
        status: "failed",
      };
    }

    const businesses = filterBusinessesForCategory(
      (googleData.places || []).map((place) => {
        const latitude = place.location?.latitude ?? null;
        const longitude = place.location?.longitude ?? null;
        const distanceMeters =
          latitude && longitude
            ? getDistanceInMeters(
                geocodeResult.latitude,
                geocodeResult.longitude,
                latitude,
                longitude,
              )
            : null;
        const name = place.displayName?.text || "Unnamed Google place";

        return {
          name,
          category: formatGooglePlaceType(place.types?.[0]),
          sourceCategoryText: (place.types || []).join(" "),
          address: place.formattedAddress || "",
          phone: place.nationalPhoneNumber || "",
          rating: place.rating ?? null,
          reviewCount: place.userRatingCount ?? null,
          review_count: place.userRatingCount ?? null,
          yelpUrl: place.googleMapsUri || "",
          url: place.googleMapsUri || "",
          latitude,
          longitude,
          distanceMeters,
          distance: distanceMeters,
          likely_chain: isLikelyChain(name),
          source: "Google Places",
        };
      }),
      categoryConfig,
    );

    return {
      businesses,
      warning: "",
      status: "ok",
    };
  } catch {
    return {
      businesses: [],
      warning: "Something went wrong while contacting Google Places.",
      status: "failed",
    };
  }
}

async function searchOpenStreetMap(categoryConfig, geocodeResult) {
  if (!hasCoordinates(geocodeResult)) {
    return {
      businesses: [],
      warning:
        geocodeResult.warning || "OpenStreetMap could not find that address.",
      status: "failed",
    };
  }

  const latitude = geocodeResult.latitude;
  const longitude = geocodeResult.longitude;

  try {
    // Overpass searches OpenStreetMap business data near the address.
    const overpassQuery = `
      [out:json][timeout:25];
      (
        ${categoryConfig.openStreetMapQueries
          .map(
            (queryPart) =>
              `${queryPart}(around:${SEARCH_RADIUS_IN_METERS},${latitude},${longitude});`,
          )
          .join("\n")}
      );
      out center 20;
    `;

    const businessData = await searchOverpass(overpassQuery);

    if (!businessData) {
      return {
        businesses: [],
        warning: "The OpenStreetMap business search could not complete this request.",
        status: "failed",
      };
    }

    const businesses = filterBusinessesForCategory(
      (businessData.elements || [])
      .filter((business) => business.tags?.name)
      .map((business) => {
        const resultLatitude = business.lat ?? business.center?.lat ?? null;
        const resultLongitude = business.lon ?? business.center?.lon ?? null;
        const distanceMeters =
          resultLatitude && resultLongitude
            ? getDistanceInMeters(
                latitude,
                longitude,
                resultLatitude,
                resultLongitude,
              )
            : null;

        return {
          name: business.tags.name,
          category:
            business.tags.cuisine ||
            business.tags.amenity ||
            business.tags.shop ||
            business.tags.craft ||
            "Local place",
          sourceCategoryText: [
            business.tags.amenity,
            business.tags.shop,
            business.tags.craft,
            business.tags.hairdresser,
            business.tags.barber,
          ]
            .filter(Boolean)
            .join(" "),
          address: buildOpenStreetMapAddress(business.tags),
          phone: business.tags.phone || business.tags["contact:phone"] || "",
          rating: null,
          reviewCount: null,
          review_count: null,
          yelpUrl: `https://www.openstreetmap.org/${business.type}/${business.id}`,
          url: `https://www.openstreetmap.org/${business.type}/${business.id}`,
          latitude: resultLatitude,
          longitude: resultLongitude,
          distanceMeters,
          distance: distanceMeters,
          likely_chain: isLikelyChain(business.tags.name),
          source: "OpenStreetMap",
        };
      }),
      categoryConfig,
    );

    return {
      businesses,
      warning: "",
      status: "ok",
    };
  } catch {
    return {
      businesses: [],
      warning: "Something went wrong while searching OpenStreetMap data.",
      status: "failed",
    };
  }
}

async function searchOverpass(overpassQuery) {
  for (const overpassUrl of OVERPASS_URLS) {
    try {
      const businessResponse = await fetch(overpassUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "User-Agent": "local-business-finder-nextjs-learning-app",
        },
        body: new URLSearchParams({ data: overpassQuery }),
      });

      if (!businessResponse.ok) {
        continue;
      }

      return await businessResponse.json();
    } catch {
      // Try the next public Overpass server.
    }
  }

  return null;
}

function getSafeYelpError(status, yelpData, apiKey) {
  const yelpDescription =
    yelpData?.error?.description ||
    yelpData?.error?.code ||
    "Yelp did not include an error description.";
  const safeDescription = hideSecretFromMessage(yelpDescription, apiKey);

  return `Yelp request failed with status ${status}: ${safeDescription}`;
}

function getSafeGooglePlacesError(status, googleData, apiKey) {
  const googleDescription =
    googleData?.error?.message ||
    googleData?.error?.status ||
    "Google Places did not include an error description.";
  const safeDescription = hideSecretFromMessage(googleDescription, apiKey);

  return `Google Places request failed with status ${status}: ${safeDescription}`;
}

function hasCoordinates(place) {
  return Number.isFinite(place?.latitude) && Number.isFinite(place?.longitude);
}

function formatGooglePlaceType(placeType = "") {
  if (!placeType) {
    return "Local place";
  }

  return placeType
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function filterBusinessesForCategory(businesses, categoryConfig) {
  if (!categoryConfig.requiresBarbershopFilter) {
    return businesses;
  }

  // Google's hair_care type and OpenStreetMap's hairdresser tag can include
  // places that are near the beauty industry but do not cut hair. This extra
  // app-level filter keeps the Barbershops category focused on haircut places.
  return businesses.filter(isLikelyBarbershop);
}

function applyChainDetection(businesses) {
  const repeatedChainNames = getRepeatedChainNames(businesses);

  return businesses.map((business) => {
    const normalizedName = normalizeChainName(business.name);

    return {
      ...business,
      // Blacklist detection catches known chain names even if they only appear
      // once. Repeated-name detection catches chain-like businesses that show
      // up from several sources with the same name.
      likely_chain:
        business.likely_chain ||
        isLikelyChain(business.name) ||
        repeatedChainNames.has(normalizedName),
    };
  });
}

function getRepeatedChainNames(businesses) {
  const nameCounts = new Map();

  for (const business of businesses) {
    const normalizedName = normalizeChainName(business.name);

    if (!normalizedName) {
      continue;
    }

    nameCounts.set(normalizedName, (nameCounts.get(normalizedName) || 0) + 1);
  }

  // If the same cleaned-up name appears 3 or more times in the raw Yelp,
  // Google Places, and OpenStreetMap results, it is probably a repeated chain
  // location rather than a one-off local business.
  return new Set(
    [...nameCounts.entries()]
      .filter(([, count]) => count >= 3)
      .map(([normalizedName]) => normalizedName),
  );
}

function removeInternalBusinessFields(business) {
  // sourceCategoryText only helps the backend filtering logic. The browser
  // cards and CSV do not need it, so we remove it before sending JSON back.
  const { sourceCategoryText, ...publicBusiness } = business;

  return publicBusiness;
}

function isLikelyBarbershop(result) {
  const nameText = normalizeBarbershopFilterText(result.name);
  const categoryText = normalizeBarbershopFilterText(
    [
      result.category,
      result.sourceCategoryText,
      ...(Array.isArray(result.types) ? result.types : []),
    ].join(" "),
  );
  const combinedText = `${nameText} ${categoryText}`.trim();

  const hasHaircutNameSignal = BARBERSHOP_NAME_TERMS.some((term) =>
    includesFilterTerm(nameText, term),
  );
  const hasHaircutCategorySignal = BARBERSHOP_CATEGORY_TERMS.some((term) =>
    includesFilterTerm(categoryText, term),
  );

  if (!hasHaircutNameSignal && !hasHaircutCategorySignal) {
    return false;
  }

  const hasBeautyOnlySignal = BARBERSHOP_EXCLUDE_TERMS.some((term) =>
    includesFilterTerm(combinedText, term),
  );
  const hasStrongHaircutNameSignal = BARBERSHOP_STRONG_NAME_TERMS.some((term) =>
    includesFilterTerm(nameText, term),
  );

  // If a result looks like cosmetics, nails, spa, lashes, wigs, or similar,
  // keep it only when the business name clearly says barber or hair salon.
  return !hasBeautyOnlySignal || hasStrongHaircutNameSignal;
}

function normalizeBarbershopFilterText(value) {
  return String(value || "")
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function includesFilterTerm(text, term) {
  const normalizedTerm = normalizeBarbershopFilterText(term);

  if (!normalizedTerm) {
    return false;
  }

  if (normalizedTerm.includes(" ")) {
    return text.includes(normalizedTerm);
  }

  return new RegExp(`(^|\\s)${escapeRegExp(normalizedTerm)}(\\s|$)`).test(
    text,
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isLikelyChain(businessName = "") {
  const normalizedBusinessName = normalizeChainName(businessName);

  // Blacklist chain detection means: if the cleaned-up business name matches
  // or starts with a known chain name, mark it as likely_chain.
  return NORMALIZED_CHAIN_BLACKLIST.some(
    (chainName) =>
      normalizedBusinessName === chainName ||
      normalizedBusinessName.startsWith(chainName),
  );
}

function normalizeChainName(name) {
  // This turns names like "7-Eleven Store #123", "7 Eleven", and "7eleven"
  // into comparable text. It also drops small legal/store suffixes that often
  // vary between Yelp, Google Places, and OpenStreetMap.
  const suffixPhrases = ["food mart"];
  let normalizedName = String(name || "")
    .toLowerCase()
    .replaceAll("&", " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  for (const phrase of suffixPhrases) {
    normalizedName = normalizedName.replace(
      new RegExp(`(^|\\s)${phrase}(\\s|$)`, "g"),
      " ",
    );
  }

  const suffixWords = new Set([
    "llc",
    "inc",
    "store",
    "gas",
    "station",
    "market",
    "convenience",
  ]);
  const tokens = normalizedName
    .split(" ")
    .filter((token) => token && !suffixWords.has(token));

  return tokens.join("");
}

function hideSecretFromMessage(message, apiKey) {
  let safeMessage = String(message);

  if (apiKey) {
    safeMessage = safeMessage.split(apiKey).join("[hidden API key]");
  }

  // Yelp can sometimes echo part of the Authorization header in validation
  // messages. This keeps the word "Bearer" for clarity but removes the token.
  return safeMessage
    .replace(/Bearer\s+[A-Za-z0-9_-]+/gi, "Bearer [hidden API key]")
    .replace(
      /X-Goog-Api-Key:\s*[A-Za-z0-9_-]+/gi,
      "X-Goog-Api-Key: [hidden API key]",
    );
}

function getDistanceInMeters(startLatitude, startLongitude, endLatitude, endLongitude) {
  // This is the haversine formula. It estimates distance between two map points.
  const earthRadiusInMeters = 6371000;
  const startLatRadians = degreesToRadians(startLatitude);
  const endLatRadians = degreesToRadians(endLatitude);
  const latDifference = degreesToRadians(endLatitude - startLatitude);
  const lonDifference = degreesToRadians(endLongitude - startLongitude);

  const a =
    Math.sin(latDifference / 2) * Math.sin(latDifference / 2) +
    Math.cos(startLatRadians) *
      Math.cos(endLatRadians) *
      Math.sin(lonDifference / 2) *
      Math.sin(lonDifference / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return Math.round(earthRadiusInMeters * c);
}

function degreesToRadians(degrees) {
  return degrees * (Math.PI / 180);
}

function buildOpenStreetMapAddress(tags) {
  const streetAddress = [tags["addr:housenumber"], tags["addr:street"]]
    .filter(Boolean)
    .join(" ");
  const cityLine = [tags["addr:city"], tags["addr:state"], tags["addr:postcode"]]
    .filter(Boolean)
    .join(", ");

  return [streetAddress, cityLine].filter(Boolean).join(", ");
}
