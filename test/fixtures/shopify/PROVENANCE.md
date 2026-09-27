# Shopify fixture provenance

These files are published-format samples for the fixture proof. They were not
captured from a Shopify store.

- `product.csv` uses the Shopify product CSV header set documented at
  https://help.shopify.com/en/manual/products/import-export/using-csv
- `products-update.json` and `inventory-level-update.json` follow the Admin REST
  webhook bodies for `products/update` and `inventory_levels/update`.
  `products-update.json` keeps the documented sample product id
  `788032119674292922`, which is larger than `2^53-1`, so the bridge reads it
  with the lossless JSON parser.
- `shirt.png` is a 1×1 PNG used as the image-byte download fixture.
- Admin GraphQL responses are built in the tests from the
  `inventoryItem.inventoryLevels` and `inventorySetQuantities` response shapes.
  The bridge does not call Shopify.
