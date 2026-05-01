"use client";

import { useEffect, useMemo, useState } from "react";
import { CATEGORY_OPTIONS } from "@/lib/category-config";

const CSV_HEADERS = [
  "name",
  "category",
  "source",
  "address",
  "phone",
  "rating",
  "review_count",
  "distance",
  "url",
  "likely_chain",
];

const RECENT_SEARCHES_STORAGE_KEY = "local-business-finder-recent-searches";
const MAX_RECENT_SEARCHES = 10;

export default function Home() {
  const [address, setAddress] = useState("");
  const [selectedAddress, setSelectedAddress] = useState("");
  const [addressSuggestions, setAddressSuggestions] = useState([]);
  const [category, setCategory] = useState("");
  const [businesses, setBusinesses] = useState([]);
  const [resultSummary, setResultSummary] = useState(null);
  const [error, setError] = useState("");
  const [sourceWarnings, setSourceWarnings] = useState([]);
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false);
  const [showAddressSuggestions, setShowAddressSuggestions] = useState(false);
  const [hideLikelyChains, setHideLikelyChains] = useState(false);
  const [hasSearched, setHasSearched] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [recentSearches, setRecentSearches] = useState([]);
  const [loadedRecentSearchId, setLoadedRecentSearchId] = useState("");

  // Dedupe happens after the API returns raw Yelp, Google Places, and
  // OpenStreetMap results.
  // We keep the original raw list in state, then compute a cleaner final list
  // for display and CSV export.
  const dedupedBusinesses = useMemo(
    () => dedupeBusinesses(businesses),
    [businesses],
  );
  const rawResultsCount = resultSummary?.rawResultsCount ?? businesses.length;
  const duplicatesRemovedCount =
    resultSummary?.duplicatesRemovedCount ??
    businesses.length - dedupedBusinesses.length;

  // These derived values keep the JSX below easier to read. They are based on
  // dedupedBusinesses, so the cards and CSV both use the final cleaned list.
  const visibleBusinesses = hideLikelyChains
    ? dedupedBusinesses.filter((business) => !business.likely_chain)
    : dedupedBusinesses;
  const likelyChainsFoundCount = dedupedBusinesses.filter(
    (business) => business.likely_chain,
  ).length;
  const yelpResultsCount = dedupedBusinesses.filter(
    (business) => business.source === "Yelp",
  ).length;
  const googlePlacesResultsCount = dedupedBusinesses.filter(
    (business) => business.source === "Google Places",
  ).length;
  const openStreetMapResultsCount = dedupedBusinesses.filter(
    (business) => business.source === "OpenStreetMap",
  ).length;

  useEffect(() => {
    // localStorage is a small browser-only storage area. We read it inside
    // useEffect because this code runs after the page opens in the browser.
    const timeoutId = window.setTimeout(() => {
      setRecentSearches(loadRecentSearchesFromStorage());
    }, 0);

    return () => window.clearTimeout(timeoutId);
  }, []);

  useEffect(() => {
    if (address === selectedAddress) {
      return;
    }

    if (address.trim().length < 3) {
      return;
    }

    const controller = new AbortController();

    // Wait a moment before searching so we do not call the server for every
    // single letter the user types.
    const timeoutId = setTimeout(async () => {
      setIsLoadingSuggestions(true);
      setShowAddressSuggestions(true);

      const searchParams = new URLSearchParams({ q: address });

      try {
        const response = await fetch(
          `/api/addresses/search?${searchParams.toString()}`,
          { signal: controller.signal },
        );
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || "Address suggestions failed.");
        }

        setAddressSuggestions(data.suggestions || []);
        setShowAddressSuggestions(true);
      } catch (suggestionError) {
        if (suggestionError.name !== "AbortError") {
          setAddressSuggestions([]);
          setShowAddressSuggestions(false);
        }
      } finally {
        setIsLoadingSuggestions(false);
      }
    }, 450);

    return () => {
      controller.abort();
      clearTimeout(timeoutId);
    };
  }, [address, selectedAddress]);

  // runSearch is the single place where the live API call happens.
  // Both the main search form and the "load recent search" button call this
  // function so that every search — whether new or repeated — always goes
  // through the latest Yelp, Google Places, OpenStreetMap, chain detection,
  // barbershop filtering, and deduplication logic.
  async function runSearch(searchAddress, searchCategory) {
    setError("");
    setBusinesses([]);
    setResultSummary(null);
    setSourceWarnings([]);
    setHasSearched(true);
    setIsLoading(true);
    setLoadedRecentSearchId("");

    // URLSearchParams safely turns form values into query-string text.
    const searchParams = new URLSearchParams({
      address: searchAddress,
      category: searchCategory,
    });

    try {
      const response = await fetch(
        `/api/businesses/search?${searchParams.toString()}`,
      );
      const data = await response.json();

      // The backend can return warnings when one source fails but another
      // source still returns useful results.
      setSourceWarnings(data.warnings || []);

      if (!response.ok) {
        throw new Error(data.error || "The search failed.");
      }

      const rawBusinesses = data.businesses || [];
      const finalDedupedBusinesses = dedupeBusinesses(rawBusinesses);
      const nextResultSummary = {
        rawResultsCount: rawBusinesses.length,
        duplicatesRemovedCount:
          rawBusinesses.length - finalDedupedBusinesses.length,
      };

      setBusinesses(rawBusinesses);
      setResultSummary(nextResultSummary);
      // Only address and category are saved — never the result objects.
      // This keeps recent searches lightweight and guarantees that the next
      // time this search is run it goes through the current pipeline.
      saveRecentSearch({
        address: searchAddress.trim(),
        category: searchCategory,
      });
    } catch (searchError) {
      setError(searchError.message);
    } finally {
      setIsLoading(false);
    }
  }

  function handleSearch(event) {
    event.preventDefault();
    runSearch(address, category);
  }

  function handleAddressChange(event) {
    const nextAddress = event.target.value;

    setAddress(nextAddress);
    setSelectedAddress("");
    setLoadedRecentSearchId("");

    if (nextAddress.trim().length < 3) {
      setAddressSuggestions([]);
      setShowAddressSuggestions(false);
    }
  }

  function chooseAddressSuggestion(suggestion) {
    setAddress(suggestion.displayName);
    setSelectedAddress(suggestion.displayName);
    setAddressSuggestions([]);
    setShowAddressSuggestions(false);
  }

  function saveRecentSearch(searchDetails) {
    const recentSearch = {
      id: createRecentSearchId(),
      address: searchDetails.address,
      category: searchDetails.category,
      createdAt: new Date().toISOString(),
      // Results are intentionally omitted. Storing result objects would mean
      // clicking a recent search restores stale data built by older code.
      // Saving only address and category keeps the storage small and forces
      // every load to go through the current search pipeline.
    };

    setRecentSearches((currentSearches) => {
      // If the same address/category is searched again, move the newer version
      // to the top instead of keeping two nearly identical saved searches.
      const withoutSameSearch = currentSearches.filter(
        (savedSearch) => !areSameRecentSearch(savedSearch, recentSearch),
      );
      const nextSearches = [recentSearch, ...withoutSameSearch].slice(
        0,
        MAX_RECENT_SEARCHES,
      );

      saveRecentSearchesToStorage(nextSearches);
      return nextSearches;
    });
  }

  function loadRecentSearch(recentSearch) {
    // When a recent search is clicked we re-run the full search pipeline using
    // the saved address and category rather than restoring old cached results.
    //
    // Why re-run instead of restore?
    // The app's logic changes over time — chain detection learns new chains,
    // barbershop filtering gets smarter, deduplication thresholds are tuned,
    // and category mappings are updated. If we restored old result objects from
    // localStorage, the user would silently see data produced by older, worse
    // code. Re-running guarantees that every search reflects the current
    // version of the app, with no extra steps from the user.
    setAddress(recentSearch.address);
    setSelectedAddress(recentSearch.address);
    setCategory(recentSearch.category);
    setAddressSuggestions([]);
    setShowAddressSuggestions(false);
    runSearch(recentSearch.address, recentSearch.category);
  }

  function clearRecentSearches() {
    setRecentSearches([]);
    setLoadedRecentSearchId("");
    clearRecentSearchesFromStorage();
  }

  function handleExportCsv() {
    // The CSV uses visibleBusinesses, so it automatically respects the
    // "Hide likely chains" checkbox.
    const csvRows = [
      CSV_HEADERS,
      ...visibleBusinesses.map((business) => [
        business.name,
        business.category,
        business.source,
        business.address,
        business.phone,
        business.rating,
        business.reviewCount ?? business.review_count,
        formatDistance(business.distanceMeters ?? business.distance),
        business.yelpUrl || business.url,
        business.likely_chain ? "true" : "false",
      ]),
    ];

    // CSV cells with commas, quotes, or line breaks need special escaping so
    // spreadsheet apps read each value in the correct column.
    const csvText = csvRows
      .map((row) => row.map(escapeCsvValue).join(","))
      .join("\n");

    // A Blob is an in-browser file. We create a temporary link, click it, then
    // remove the link so the browser downloads the CSV.
    const csvBlob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
    const csvUrl = URL.createObjectURL(csvBlob);
    const downloadLink = document.createElement("a");

    downloadLink.href = csvUrl;
    downloadLink.download = "local-business-results.csv";
    downloadLink.click();
    URL.revokeObjectURL(csvUrl);
  }

  return (
    <main className="min-h-screen bg-slate-50 px-6 py-10 text-slate-950 sm:px-10">
      <section className="mx-auto flex w-full max-w-5xl flex-col gap-8">
        <div className="max-w-2xl">
          <p className="mb-3 text-sm font-semibold uppercase tracking-[0.2em] text-teal-700">
            Local Business Finder
          </p>
          <h1 className="text-4xl font-bold leading-tight sm:text-5xl">
            Find nearby places from one simple search.
          </h1>
          <p className="mt-4 text-lg leading-7 text-slate-500">
            Enter an address, choose a category, and search Yelp, Google
            Places, and map data for businesses within about 20 miles.
          </p>
        </div>

        <form
          className="grid gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm sm:grid-cols-[1fr_220px_auto]"
          onSubmit={handleSearch}
        >
          <div className="relative flex flex-col gap-1.5">
            <label
              className="text-sm font-medium text-slate-700"
              htmlFor="address"
            >
              Address
            </label>
            <input
              autoComplete="off"
              className="h-11 rounded-lg border border-slate-300 px-4 text-sm outline-none transition focus:border-teal-600 focus:ring-4 focus:ring-teal-100"
              id="address"
              name="address"
              onBlur={() => {
                setTimeout(() => setShowAddressSuggestions(false), 150);
              }}
              onChange={handleAddressChange}
              onFocus={() => {
                if (addressSuggestions.length > 0) {
                  setShowAddressSuggestions(true);
                }
              }}
              placeholder="123 Main St, Detroit, MI"
              required
              type="text"
              value={address}
            />
            {showAddressSuggestions ? (
              <div className="absolute left-0 right-0 top-full z-20 mt-1.5 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
                {isLoadingSuggestions ? (
                  <p className="px-4 py-3 text-sm text-slate-400">
                    Looking up addresses…
                  </p>
                ) : null}

                {!isLoadingSuggestions && addressSuggestions.length === 0 ? (
                  <p className="px-4 py-3 text-sm text-slate-400">
                    No address suggestions found.
                  </p>
                ) : null}

                {!isLoadingSuggestions &&
                  addressSuggestions.map((suggestion) => (
                    <button
                      className="block w-full px-4 py-2.5 text-left text-sm text-slate-700 transition hover:bg-teal-50 hover:text-teal-900"
                      key={suggestion.id}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => chooseAddressSuggestion(suggestion)}
                      type="button"
                    >
                      {suggestion.displayName}
                    </button>
                  ))}
              </div>
            ) : null}
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-slate-700">Category</span>
            <select
              className="h-11 rounded-lg border border-slate-300 bg-white px-4 text-sm outline-none transition focus:border-teal-600 focus:ring-4 focus:ring-teal-100"
              name="category"
              onChange={(event) => {
                setCategory(event.target.value);
                setLoadedRecentSearchId("");
              }}
              required
              value={category}
            >
              <option value="" disabled>
                Choose one
              </option>
              {CATEGORY_OPTIONS.map((categoryOption) => (
                <option key={categoryOption.value} value={categoryOption.value}>
                  {categoryOption.label}
                </option>
              ))}
            </select>
          </label>

          <button
            className="h-11 w-full self-end rounded-lg bg-teal-700 px-6 text-sm font-semibold text-white transition hover:bg-teal-800 focus:outline-none focus:ring-4 focus:ring-teal-200 disabled:cursor-not-allowed disabled:bg-slate-300 sm:w-auto"
            disabled={isLoading}
            type="submit"
          >
            {isLoading ? "Searching…" : "Search"}
          </button>
        </form>

        <section aria-label="Recent searches" className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-slate-500">
              Recent searches
            </h2>
            <button
              className="text-sm text-slate-400 transition hover:text-red-500 disabled:cursor-not-allowed disabled:opacity-40"
              disabled={recentSearches.length === 0}
              onClick={clearRecentSearches}
              type="button"
            >
              Clear all
            </button>
          </div>

          {recentSearches.length > 0 ? (
            <div className="grid gap-2.5 sm:grid-cols-2">
              {recentSearches.map((recentSearch) => {
                const isLoaded = loadedRecentSearchId === recentSearch.id;

                return (
                  <button
                    className={`rounded-xl border bg-white p-4 text-left shadow-sm transition hover:border-teal-400 hover:shadow-md ${
                      isLoaded
                        ? "border-teal-500 ring-4 ring-teal-100"
                        : "border-slate-200"
                    }`}
                    key={recentSearch.id}
                    onClick={() => loadRecentSearch(recentSearch)}
                    type="button"
                  >
                    <span className="block truncate text-sm font-semibold text-slate-800">
                      {recentSearch.address}
                    </span>
                    <span className="mt-2 block">
                      <span className="inline-block rounded-full bg-teal-100 px-2.5 py-0.5 text-xs font-medium text-teal-700">
                        {getCategoryLabel(recentSearch.category)}
                      </span>
                    </span>
                    <span className="mt-2 block text-xs text-slate-400">
                      {formatSavedSearchDate(recentSearch.createdAt)}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-200 bg-white p-5 text-center text-sm text-slate-400">
              No recent searches yet.
            </div>
          )}
        </section>

        <section aria-label="Search results" className="space-y-3">
          {sourceWarnings.length > 0 ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-amber-900">
                <span aria-hidden="true">⚠</span>
                Partial results
              </p>
              <ul className="mt-1.5 space-y-0.5">
                {sourceWarnings.map((warning) => (
                  <li className="text-sm text-amber-800" key={warning}>
                    {warning}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {dedupedBusinesses.length > 0 ? (
            <div className="flex flex-col gap-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:flex-row sm:items-start sm:justify-between">
              <div className="flex flex-col gap-3">
                <div className="flex flex-wrap gap-2">
                  <div className="flex flex-col items-center rounded-lg bg-slate-50 px-4 py-2">
                    <span className="text-2xl font-bold leading-none text-slate-950">
                      {visibleBusinesses.length}
                    </span>
                    <span className="mt-1 text-xs text-slate-500">results</span>
                  </div>
                  <div className="flex flex-col items-center rounded-lg bg-slate-50 px-4 py-2">
                    <span className="text-2xl font-bold leading-none text-slate-950">
                      {duplicatesRemovedCount}
                    </span>
                    <span className="mt-1 text-xs text-slate-500">duplicates removed</span>
                  </div>
                  {likelyChainsFoundCount > 0 ? (
                    <div className="flex flex-col items-center rounded-lg bg-amber-50 px-4 py-2">
                      <span className="text-2xl font-bold leading-none text-amber-700">
                        {likelyChainsFoundCount}
                      </span>
                      <span className="mt-1 text-xs text-amber-600">likely chains</span>
                    </div>
                  ) : null}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-xs text-slate-400">{rawResultsCount} raw ·</span>
                  {yelpResultsCount > 0 ? (
                    <span className="rounded-full bg-rose-100 px-2.5 py-0.5 text-xs font-medium text-rose-700">
                      Yelp · {yelpResultsCount}
                    </span>
                  ) : null}
                  {googlePlacesResultsCount > 0 ? (
                    <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-xs font-medium text-blue-700">
                      Google · {googlePlacesResultsCount}
                    </span>
                  ) : null}
                  {openStreetMapResultsCount > 0 ? (
                    <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600">
                      OSM · {openStreetMapResultsCount}
                    </span>
                  ) : null}
                </div>
              </div>

              <div className="flex flex-row items-center gap-4 sm:flex-col sm:items-end">
                <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-slate-700">
                  <input
                    checked={hideLikelyChains}
                    className="h-4 w-4 accent-teal-700"
                    onChange={(event) =>
                      setHideLikelyChains(event.target.checked)
                    }
                    type="checkbox"
                  />
                  Hide likely chains
                </label>
                <button
                  className="rounded-lg border border-teal-700 px-4 py-1.5 text-sm font-semibold text-teal-700 transition hover:bg-teal-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-400 disabled:hover:bg-transparent"
                  disabled={visibleBusinesses.length === 0}
                  onClick={handleExportCsv}
                  type="button"
                >
                  Export CSV
                </button>
              </div>
            </div>
          ) : null}

          {error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm font-medium text-red-800">
              {error}
            </div>
          ) : null}

          {isLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((n) => (
                <div
                  key={n}
                  className="animate-pulse rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
                >
                  <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 pb-4">
                    <div className="h-5 w-44 rounded-md bg-slate-200" />
                    <div className="h-5 w-16 rounded-full bg-slate-200" />
                  </div>
                  <div className="mt-4 grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <div className="h-3 w-12 rounded bg-slate-200" />
                      <div className="h-4 w-40 rounded bg-slate-200" />
                    </div>
                    <div className="space-y-1.5">
                      <div className="h-3 w-12 rounded bg-slate-200" />
                      <div className="h-4 w-28 rounded bg-slate-200" />
                    </div>
                    <div className="space-y-1.5">
                      <div className="h-3 w-12 rounded bg-slate-200" />
                      <div className="h-4 w-20 rounded bg-slate-200" />
                    </div>
                  </div>
                  <div className="mt-5 h-8 w-28 rounded-lg bg-slate-200" />
                </div>
              ))}
            </div>
          ) : null}

          {!error && !isLoading && !hasSearched ? (
            <div className="flex min-h-56 items-center justify-center rounded-xl border border-dashed border-slate-200 bg-white p-6 text-center">
              <div>
                <p className="font-medium text-slate-700">Ready to search</p>
                <p className="mt-1 text-sm text-slate-400">
                  Enter an address and choose a category above to find nearby
                  businesses.
                </p>
              </div>
            </div>
          ) : null}

          {!error && !isLoading && hasSearched && dedupedBusinesses.length === 0 ? (
            <div className="flex min-h-56 items-center justify-center rounded-xl border border-dashed border-slate-200 bg-white p-6 text-center">
              <div>
                <p className="font-medium text-slate-700">No results found</p>
                <p className="mt-1 text-sm text-slate-400">
                  Try a different address or switch to another category.
                </p>
              </div>
            </div>
          ) : null}

          {!error &&
          !isLoading &&
          dedupedBusinesses.length > 0 &&
          visibleBusinesses.length === 0 ? (
            <div className="flex min-h-56 items-center justify-center rounded-xl border border-dashed border-slate-200 bg-white p-6 text-center">
              <div>
                <p className="font-medium text-slate-700">All results are hidden</p>
                <p className="mt-1 text-sm text-slate-400">
                  Uncheck "Hide likely chains" above to see them.
                </p>
              </div>
            </div>
          ) : null}

          {visibleBusinesses.map((business) => {
            const resultSource = business.source || "Yelp";
            const resultLink = business.yelpUrl || business.url;
            const resultLinkLabel = getResultLinkLabel(resultSource);
            const distanceText = formatDistance(
              business.distanceMeters ?? business.distance,
            );
            const reviewCount = business.reviewCount ?? business.review_count;

            return (
              <article
                className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"
                key={`${business.name}-${business.latitude}-${business.longitude}`}
              >
                <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 pb-4">
                  <h2 className="text-lg font-semibold text-slate-950">
                    {business.name}
                  </h2>
                  <span
                    className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${getSourceBadgeClass(resultSource)}`}
                  >
                    {resultSource}
                  </span>
                  {business.likely_chain ? (
                    <span className="rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-semibold text-amber-800">
                      Likely chain
                    </span>
                  ) : null}
                </div>

                <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                      Address
                    </dt>
                    <dd className="mt-1 text-slate-800">
                      {business.address || "Address unavailable"}
                    </dd>
                  </div>

                  {business.phone ? (
                    <div>
                      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                        Phone
                      </dt>
                      <dd className="mt-1 text-slate-800">{business.phone}</dd>
                    </div>
                  ) : null}

                  {(business.rating !== null &&
                    business.rating !== undefined) ||
                  (reviewCount !== null && reviewCount !== undefined) ? (
                    <div>
                      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                        Rating
                      </dt>
                      <dd className="mt-1 text-slate-800">
                        {business.rating !== null &&
                        business.rating !== undefined
                          ? `${business.rating} ★`
                          : ""}
                        {business.rating !== null &&
                        business.rating !== undefined &&
                        reviewCount !== null &&
                        reviewCount !== undefined
                          ? " · "
                          : ""}
                        {reviewCount !== null && reviewCount !== undefined
                          ? `${reviewCount} reviews`
                          : ""}
                      </dd>
                    </div>
                  ) : null}

                  {distanceText ? (
                    <div>
                      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">
                        Distance
                      </dt>
                      <dd className="mt-1 text-slate-800">{distanceText}</dd>
                    </div>
                  ) : null}
                </dl>

                {resultLink ? (
                  <a
                    className="mt-4 inline-flex rounded-lg border border-teal-700 px-4 py-1.5 text-sm font-semibold text-teal-700 transition hover:bg-teal-50"
                    href={resultLink}
                    rel="noopener noreferrer"
                    target="_blank"
                  >
                    {resultLinkLabel}
                  </a>
                ) : null}
              </article>
            );
          })}
        </section>
      </section>
    </main>
  );
}

function loadRecentSearchesFromStorage() {
  if (typeof window === "undefined") {
    return [];
  }

  try {
    // localStorage can only save text. We store the recent-search array as a
    // JSON string, then JSON.parse turns that text back into JavaScript data.
    const savedSearchesText = window.localStorage.getItem(
      RECENT_SEARCHES_STORAGE_KEY,
    );

    if (!savedSearchesText) {
      return [];
    }

    const savedSearches = JSON.parse(savedSearchesText);

    if (!Array.isArray(savedSearches)) {
      return [];
    }

    return savedSearches
      .filter(isUsableRecentSearch)
      .slice(0, MAX_RECENT_SEARCHES);
  } catch {
    // If the browser has broken saved data for any reason, starting with an
    // empty recent-search list is safer than breaking the page.
    return [];
  }
}

function saveRecentSearchesToStorage(recentSearches) {
  if (typeof window === "undefined") {
    return;
  }

  try {
    // JSON.stringify turns the JavaScript array into plain text that
    // localStorage can keep even after the page is refreshed.
    window.localStorage.setItem(
      RECENT_SEARCHES_STORAGE_KEY,
      JSON.stringify(recentSearches),
    );
  } catch {
    // Some browsers can block storage or run out of space. The search results
    // still work, so we quietly skip saving instead of showing a scary error.
  }
}

function clearRecentSearchesFromStorage() {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.removeItem(RECENT_SEARCHES_STORAGE_KEY);
  } catch {
    // If storage is blocked, the in-memory React state was still cleared.
  }
}

function isUsableRecentSearch(savedSearch) {
  // We only require id, address, category, and createdAt — the fields needed
  // to display a card and re-run the search. We no longer require a "results"
  // field. Old entries saved by a previous version of this app do have a
  // results field, but we ignore it and always re-run instead of restoring it.
  return (
    savedSearch &&
    typeof savedSearch.id === "string" &&
    typeof savedSearch.address === "string" &&
    typeof savedSearch.category === "string" &&
    typeof savedSearch.createdAt === "string"
  );
}

function areSameRecentSearch(firstSearch, secondSearch) {
  return (
    normalizeForComparison(firstSearch.address) ===
      normalizeForComparison(secondSearch.address) &&
    firstSearch.category === secondSearch.category
  );
}

function createRecentSearchId() {
  if (
    typeof window !== "undefined" &&
    window.crypto &&
    typeof window.crypto.randomUUID === "function"
  ) {
    return window.crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function getCategoryLabel(categoryValue) {
  return (
    CATEGORY_OPTIONS.find(
      (categoryOption) => categoryOption.value === categoryValue,
    )
      ?.label || categoryValue
  );
}

function formatSavedSearchDate(createdAt) {
  const savedDate = new Date(createdAt);

  if (Number.isNaN(savedDate.getTime())) {
    return "Date unavailable";
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(savedDate);
}

function formatDistance(distanceMeters) {
  if (distanceMeters === null || distanceMeters === undefined) {
    return "";
  }

  // The API sends distance in meters. Users in this app are more likely to
  // understand miles, so we convert it before showing it on the card.
  const distanceMiles = distanceMeters / 1609.344;

  if (distanceMiles < 0.1) {
    return "Less than 0.1 miles away";
  }

  return `${distanceMiles.toFixed(1)} miles away`;
}

function getSourceBadgeClass(source) {
  if (source === "Yelp") {
    return "bg-rose-100 text-rose-700";
  }
  if (source === "Google Places") {
    return "bg-blue-100 text-blue-700";
  }
  return "bg-slate-100 text-slate-600";
}

function getResultLinkLabel(source) {
  if (source === "Yelp") {
    return "View on Yelp";
  }

  if (source === "Google Places") {
    return "Open in Google Maps";
  }

  return "Open map";
}

function dedupeBusinesses(rawBusinesses) {
  // Yelp usually has the richest details, then Google Places, then
  // OpenStreetMap. Sorting by that order means the best version is kept when
  // multiple sources return the same business.
  const sortedBusinesses = [...rawBusinesses].sort((first, second) => {
    return getSourcePriority(first.source) - getSourcePriority(second.source);
  });
  const finalBusinesses = [];

  for (const business of sortedBusinesses) {
    const duplicateIndex = finalBusinesses.findIndex((savedBusiness) =>
      areLikelySameBusiness(savedBusiness, business),
    );

    if (duplicateIndex === -1) {
      finalBusinesses.push(business);
      continue;
    }

    // This is a safety net in case the list order ever changes. If a better
    // source appears after a weaker duplicate, replace the weaker record.
    if (
      getSourcePriority(business.source) <
      getSourcePriority(finalBusinesses[duplicateIndex].source)
    ) {
      finalBusinesses[duplicateIndex] = business;
    }
  }

  return finalBusinesses;
}

function getSourcePriority(source) {
  if (source === "Yelp") {
    return 1;
  }

  if (source === "Google Places") {
    return 2;
  }

  if (source === "OpenStreetMap") {
    return 3;
  }

  return 99;
}

function areLikelySameBusiness(first, second) {
  // Two records must have very similar names. Then they also need either a
  // similar address or coordinates that are close together.
  return (
    areNamesVerySimilar(first.name, second.name) &&
    (areAddressesVerySimilar(first.address, second.address) ||
      areCoordinatesClose(first, second))
  );
}

function areNamesVerySimilar(firstName, secondName) {
  const first = normalizeForComparison(firstName);
  const second = normalizeForComparison(secondName);

  if (!first || !second) {
    return false;
  }

  if (first === second) {
    return true;
  }

  const firstCompact = first.replaceAll(" ", "");
  const secondCompact = second.replaceAll(" ", "");

  // This catches names like "Valero" and "Valero Gas".
  if (
    firstCompact.length >= 4 &&
    secondCompact.length >= 4 &&
    (firstCompact.includes(secondCompact) ||
      secondCompact.includes(firstCompact))
  ) {
    return true;
  }

  return (
    getTokenSimilarity(first, second) >= 0.8 ||
    getStringSimilarity(firstCompact, secondCompact) >= 0.86
  );
}

function areAddressesVerySimilar(firstAddress, secondAddress) {
  const first = normalizeForComparison(firstAddress);
  const second = normalizeForComparison(secondAddress);

  if (!first || !second) {
    return false;
  }

  if (first === second) {
    return true;
  }

  const firstCompact = first.replaceAll(" ", "");
  const secondCompact = second.replaceAll(" ", "");

  return (
    getTokenSimilarity(first, second) >= 0.7 ||
    getStringSimilarity(firstCompact, secondCompact) >= 0.82
  );
}

function areCoordinatesClose(first, second) {
  if (
    first.latitude === null ||
    first.latitude === undefined ||
    first.longitude === null ||
    first.longitude === undefined ||
    second.latitude === null ||
    second.latitude === undefined ||
    second.longitude === null ||
    second.longitude === undefined
  ) {
    return false;
  }

  // Around 150 meters gives a little wiggle room because different data sources
  // may place the pin at a driveway, building center, or storefront.
  return (
    getDistanceInMeters(
      first.latitude,
      first.longitude,
      second.latitude,
      second.longitude,
    ) <= 150
  );
}

function getDistanceInMeters(startLatitude, startLongitude, endLatitude, endLongitude) {
  // The Haversine formula estimates the real-world distance between two
  // latitude/longitude points on Earth. We use it here so deduplication can
  // treat two listings as the same business when their map pins are very close.
  const earthRadiusInMeters = 6371000;
  const startLatRadians = degreesToRadians(startLatitude);
  const endLatRadians = degreesToRadians(endLatitude);
  const latDifference = degreesToRadians(endLatitude - startLatitude);
  const lonDifference = degreesToRadians(endLongitude - startLongitude);

  const haversinePart =
    Math.sin(latDifference / 2) * Math.sin(latDifference / 2) +
    Math.cos(startLatRadians) *
      Math.cos(endLatRadians) *
      Math.sin(lonDifference / 2) *
      Math.sin(lonDifference / 2);
  const angularDistance =
    2 * Math.atan2(Math.sqrt(haversinePart), Math.sqrt(1 - haversinePart));

  return Math.round(earthRadiusInMeters * angularDistance);
}

function degreesToRadians(degrees) {
  // JavaScript trig functions use radians, while map coordinates are degrees.
  return degrees * (Math.PI / 180);
}

function normalizeForComparison(value) {
  // This normalization makes "Bob's Burgers", "Bobs Burgers", and
  // "Bob & Burgers" easier to compare in a consistent way.
  return String(value || "")
    .toLowerCase()
    .replaceAll("&", " and ")
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function getTokenSimilarity(firstValue, secondValue) {
  const firstTokens = new Set(firstValue.split(" ").filter(Boolean));
  const secondTokens = new Set(secondValue.split(" ").filter(Boolean));
  const sharedTokens = [...firstTokens].filter((token) =>
    secondTokens.has(token),
  );
  const largestTokenCount = Math.max(firstTokens.size, secondTokens.size);

  if (largestTokenCount === 0) {
    return 0;
  }

  return sharedTokens.length / largestTokenCount;
}

function getStringSimilarity(firstValue, secondValue) {
  const longestLength = Math.max(firstValue.length, secondValue.length);

  if (longestLength === 0) {
    return 1;
  }

  return 1 - getEditDistance(firstValue, secondValue) / longestLength;
}

function getEditDistance(firstValue, secondValue) {
  // Edit distance counts the smallest number of single-character changes needed
  // to turn one string into the other. Smaller distance means more similarity.
  const previousRow = Array.from(
    { length: secondValue.length + 1 },
    (_, index) => index,
  );

  for (let firstIndex = 0; firstIndex < firstValue.length; firstIndex += 1) {
    const currentRow = [firstIndex + 1];

    for (let secondIndex = 0; secondIndex < secondValue.length; secondIndex += 1) {
      const insertCost = currentRow[secondIndex] + 1;
      const deleteCost = previousRow[secondIndex + 1] + 1;
      const replaceCost =
        previousRow[secondIndex] +
        (firstValue[firstIndex] === secondValue[secondIndex] ? 0 : 1);

      currentRow.push(Math.min(insertCost, deleteCost, replaceCost));
    }

    previousRow.splice(0, previousRow.length, ...currentRow);
  }

  return previousRow[secondValue.length];
}

function escapeCsvValue(value) {
  const stringValue = value === null || value === undefined ? "" : String(value);

  if (
    stringValue.includes(",") ||
    stringValue.includes('"') ||
    stringValue.includes("\n")
  ) {
    return `"${stringValue.replaceAll('"', '""')}"`;
  }

  return stringValue;
}
