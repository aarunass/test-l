# test-l

Static web tool that calculates the Nord Pool day-ahead clearing price (EUR/MWh) for every trading period in an aggregated supply/demand curve file such as `AggregatedOrder_2023-01-01_PriceCurves_BALTIC.csv`.

## How it works

- Upload the CSV on the page. It is parsed and analysed entirely in the browser; nothing is uploaded, stored or committed.
- For each period, the supply and demand points are ordered by `SeqNr`, joined with straight lines, and intersected. When the curves overlap on a vertical segment over a price range, the midpoint of that range is used and flagged in the results.
- The page shows the hourly price chart, the supply/demand curves for any period, a results table and a CSV export.

Expected columns: `DeliveryDateCET, Area, SupplyDemand, HourIndex_1_25, StartTimeUTC, SeqNr, Qty_MWH, PriceAmount_EUR`.

## Deployment

Deployed by Cloudflare Workers Builds from `main`. `wrangler.jsonc` publishes the static files in `public/` (`index.html`, `styles.css`, `app.js`) as Worker assets; there is no build step. Data files (`*.csv`, `*.xlsx`) are git-ignored.
