const OPENSTREETMAP_SEARCH_URL = "https://nominatim.openstreetmap.org/search";

// This backend route powers the address suggestions under the address input.
// The browser calls /api/addresses/search?q=some-address, and this server file
// asks OpenStreetMap for matching addresses.
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim();

  if (!query || query.length < 3) {
    return Response.json({ suggestions: [] });
  }

  const addressSearchParams = new URLSearchParams({
    q: query,
    format: "json",
    addressdetails: "1",
    countrycodes: "us",
    limit: "5",
  });

  try {
    const response = await fetch(
      `${OPENSTREETMAP_SEARCH_URL}?${addressSearchParams.toString()}`,
      {
        headers: {
          Accept: "application/json",
          // Public OpenStreetMap services ask apps to identify themselves.
          "User-Agent": "local-business-finder-nextjs-learning-app",
        },
      },
    );

    if (!response.ok) {
      return Response.json(
        { error: "Address suggestions are unavailable right now." },
        { status: response.status },
      );
    }

    const data = await response.json();

    // OpenStreetMap returns many fields. We turn each match into a small object
    // the frontend can display in the dropdown.
    const suggestions = data.map((place) => ({
      id: String(place.place_id),
      displayName: place.display_name,
      latitude: place.lat,
      longitude: place.lon,
    }));

    return Response.json({ suggestions });
  } catch {
    return Response.json(
      { error: "Something went wrong while looking up addresses." },
      { status: 500 },
    );
  }
}
