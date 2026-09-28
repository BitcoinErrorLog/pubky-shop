# Shopify fixture provenance

These files are published-format samples for the fixture proof. They were not
captured from a Shopify store. Shopify's sample CSV download was blocked on
2026-09-28, so the current-header fixture follows the column table on the
help page rather than a downloaded file.

- `product.csv` uses the legacy header names from
  https://help.shopify.com/en/manual/products/import-export/using-csv
  (`Handle`, `Body (HTML)`, `Variant SKU`, `Variant Price`,
  `Variant Inventory Qty`).
- `product-current.csv` uses the current names from that same table
  (`URL handle`, `Description`, `SKU`, `Price`, `Inventory quantity`,
  `Published on online store`), plus loss columns from the same page
  (`Price / International`, `Collection`, SEO, cost, barcode).
- `products-update.json` and `inventory-level-update.json` follow the Admin REST
  webhook bodies for `products/update` and `inventory_levels/update`.
  `products-update.json` keeps the documented sample product id
  `788032119674292922`, which is larger than `2^53-1`, so the bridge reads it
  with the lossless JSON parser.
- `shirt.png` is a 1×1 PNG used as the image-byte download fixture.
- Admin GraphQL responses are built in the tests from the
  `inventoryItem.inventoryLevels` and `inventorySetQuantities` response shapes,
  including `userErrors.code` values `COMPARE_QUANTITY_STALE` and
  `INVALID_COMPARE_QUANTITY`. The bridge does not call Shopify.
