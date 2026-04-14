#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const BASE = 'https://connect.squareup.com/v2';
const SQUARE_VERSION = '2024-10-17';

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (!process.env[key]) {
      process.env[key] = rest.join('=');
    }
  }
}

loadEnvFile(path.join(process.cwd(), '.env.local'));

const TOKEN = process.env.SQUARE_TOKEN || process.env.NEXT_PUBLIC_SQUARE_ACCESS_TOKEN;
if (!TOKEN) {
  console.error('SQUARE_TOKEN or NEXT_PUBLIC_SQUARE_ACCESS_TOKEN is required');
  process.exit(1);
}

async function sq(pathname, method = 'GET', body = null) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      'Square-Version': SQUARE_VERSION,
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const data = await response.json();
  if (!response.ok || data.errors?.length) {
    throw new Error(`Square API error for ${pathname}: ${JSON.stringify(data.errors || data, null, 2)}`);
  }
  return data;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function searchCategories() {
  const data = await sq('/catalog/search', 'POST', {
    object_types: ['CATEGORY'],
    limit: 1000,
  });
  return data.objects || [];
}

async function searchItemsByKeyword(keyword) {
  const data = await sq('/catalog/search', 'POST', {
    object_types: ['ITEM'],
    query: {
      text_query: {
        keywords: [keyword],
      },
    },
    limit: 100,
  });
  return data.objects || [];
}

async function ensureCategory(name) {
  const categories = await searchCategories();
  const existing = categories.find((obj) => !obj.is_deleted && obj.category_data?.name === name);
  if (existing) return existing.id;

  const tempId = `#cat_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;
  const result = await sq('/catalog/batch-upsert', 'POST', {
    idempotency_key: `mm-category-${name}-${Date.now()}`,
    batches: [{
      objects: [{
        type: 'CATEGORY',
        id: tempId,
        present_at_all_locations: true,
        category_data: { name },
      }],
    }],
  });

  const created = (result.objects || []).find((obj) => obj.type === 'CATEGORY' && obj.category_data?.name === name);
  if (!created) {
    throw new Error(`Failed to create category ${name}`);
  }
  return created.id;
}

function buildItemUpdate(fullItem, mutate) {
  const updated = clone(fullItem);
  mutate(updated);
  return updated;
}

function buildFireplaceItem(tempItemId, sourceItem, categoryId) {
  const source = sourceItem.item_data;
  return {
    type: 'ITEM',
    id: tempItemId,
    present_at_all_locations: true,
    item_data: {
      name: 'TV Installation Over Fireplace',
      is_taxable: source.is_taxable,
      ordinal: source.ordinal,
      tax_ids: clone(source.tax_ids || []),
      product_type: source.product_type,
      skip_modifier_screen: source.skip_modifier_screen,
      ecom_visibility: source.ecom_visibility,
      reporting_category: { id: categoryId },
      is_archived: false,
      variations: (source.variations || []).map((variation, index) => {
        const variationData = clone(variation.item_variation_data);
        return {
          type: 'ITEM_VARIATION',
          id: `#fireplace_var_${index + 1}`,
          present_at_all_locations: true,
          item_variation_data: {
            ...variationData,
            item_id: tempItemId,
            name: variationData.name,
            ordinal: variationData.ordinal ?? index,
            pricing_type: 'FIXED_PRICING',
            price_money: {
              amount: (variationData.price_money?.amount || 0) + 5000,
              currency: 'USD',
            },
          },
        };
      }),
    },
  };
}

async function main() {
  const standardItemId = 'FHZANUTIBZHNTOIJPAEM526L';
  const specialItemId = 'EGAEWO6HZTLTN2O22WMX3K43';
  const fireplaceHelperId = '5CLTNDTZMQZ7ITPWOBQZADOS';

  const batch = await sq('/catalog/batch-retrieve', 'POST', {
    object_ids: [standardItemId, specialItemId, fireplaceHelperId],
  });

  const standardItem = (batch.objects || []).find((obj) => obj.id === standardItemId);
  const specialItem = (batch.objects || []).find((obj) => obj.id === specialItemId);
  const fireplaceHelper = (batch.objects || []).find((obj) => obj.id === fireplaceHelperId);

  if (!standardItem || !specialItem || !fireplaceHelper) {
    throw new Error('Missing one or more required Square items');
  }

  const neutralCategoryId = await ensureCategory('TV Installation');
  const fireplaceCategoryId = await ensureCategory('TV Installation Over Fireplace');
  const specialCategoryId = await ensureCategory('Special TV Installation');

  const existingFireplaceItems = await searchItemsByKeyword('TV Installation Over Fireplace');
  const existingFireplaceItem = existingFireplaceItems.find(
    (obj) => !obj.is_deleted && obj.item_data?.name === 'TV Installation Over Fireplace'
  );

  const objects = [];

  objects.push(buildItemUpdate(standardItem, (updated) => {
    updated.item_data.reporting_category = { id: neutralCategoryId };
  }));

  objects.push(buildItemUpdate(specialItem, (updated) => {
    updated.item_data.reporting_category = { id: specialCategoryId };
  }));

  objects.push(buildItemUpdate(fireplaceHelper, (updated) => {
    updated.item_data.name = 'ZZ Legacy Sync - Above Fireplace';
  }));

  if (existingFireplaceItem) {
    objects.push(buildItemUpdate(existingFireplaceItem, (updated) => {
      updated.item_data.name = 'TV Installation Over Fireplace';
      updated.item_data.reporting_category = { id: fireplaceCategoryId };
      updated.item_data.tax_ids = clone(standardItem.item_data.tax_ids || []);
      updated.item_data.is_taxable = standardItem.item_data.is_taxable;
      updated.item_data.product_type = standardItem.item_data.product_type;
      updated.item_data.skip_modifier_screen = standardItem.item_data.skip_modifier_screen;
      updated.item_data.ecom_visibility = standardItem.item_data.ecom_visibility;
      updated.item_data.variations = updated.item_data.variations.map((variation, index) => {
        const sourceVariation = standardItem.item_data.variations[index]?.item_variation_data;
        const current = variation.item_variation_data;
        return {
          ...variation,
          item_variation_data: {
            ...current,
            name: sourceVariation?.name || current.name,
            ordinal: sourceVariation?.ordinal ?? current.ordinal ?? index,
            pricing_type: 'FIXED_PRICING',
            price_money: {
              amount: (sourceVariation?.price_money?.amount || 0) + 5000,
              currency: 'USD',
            },
            service_duration: sourceVariation?.service_duration || current.service_duration,
            available_for_booking: sourceVariation?.available_for_booking ?? current.available_for_booking,
            team_member_ids: clone(sourceVariation?.team_member_ids || current.team_member_ids || []),
          },
        };
      });
    }));
  } else {
    objects.push(buildFireplaceItem('#tv_installation_over_fireplace', standardItem, fireplaceCategoryId));
  }

  await sq('/catalog/batch-upsert', 'POST', {
    idempotency_key: `mm-split-fireplace-service-${Date.now()}`,
    batches: [{ objects }],
  });

  console.log('Square catalog updated: standard/fireplace TV installation split is live.');
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
