/**
 * Zoho Books response shapes — specification section 16.
 *
 * Zoho's item payload varies by account configuration (locations vs
 * warehouses, custom fields, item-group membership). Every field is therefore
 * optional here and read through the defensive accessors in `items.ts` rather
 * than being trusted positionally.
 */

export interface ZohoCustomField {
  customfield_id?: string;
  label?: string;
  api_name?: string;
  value?: unknown;
}

export interface ZohoLocationStock {
  location_id?: string;
  location_name?: string;
  location_stock_on_hand?: number | string;
  location_available_stock?: number | string;
  is_primary?: boolean;
  status?: string;
}

export interface ZohoWarehouseStock {
  warehouse_id?: string;
  warehouse_name?: string;
  warehouse_stock_on_hand?: number | string;
  warehouse_available_stock?: number | string;
  is_primary?: boolean;
  status?: string;
}

export interface ZohoPreferredVendor {
  vendor_id?: string;
  vendor_name?: string;
  is_primary?: boolean;
}

/** Item summary as returned by the item LIST endpoint. */
export interface ZohoItemSummary {
  item_id?: string;
  name?: string;
  sku?: string;
  status?: string;
  product_type?: string;
  item_type?: string;
  track_inventory?: boolean;
  stock_on_hand?: number | string;
  unit?: string;
  brand?: string;
  manufacturer?: string;
  group_name?: string;
}

/** Item detail as returned by the single-item endpoint. */
export interface ZohoItemDetail extends ZohoItemSummary {
  description?: string;
  purchase_description?: string;
  vendor_id?: string;
  vendor_name?: string;
  preferred_vendors?: ZohoPreferredVendor[];
  locations?: ZohoLocationStock[];
  warehouses?: ZohoWarehouseStock[];
  custom_fields?: ZohoCustomField[];
  available_stock?: number | string;
  actual_available_stock?: number | string;
  image_document_id?: string;
}


export interface ZohoOrganization {
  organization_id?: string;
  name?: string;
  is_default_org?: boolean;
  currency_code?: string;
  time_zone?: string;
  country?: string;
}

export interface ZohoLocationRecord {
  location_id?: string;
  location_name?: string;
  type?: string;
  status?: string;
  is_primary?: boolean;
}

export interface ZohoWarehouseRecord {
  warehouse_id?: string;
  warehouse_name?: string;
  status?: string;
  is_primary?: boolean;
}

/* ------------------------------------------------------- envelope wrappers */

/** Fields common to every Zoho list response. */
export interface ZohoListResponse {
  code?: number;
  message?: string;
  page_context?: {
    page?: number;
    per_page?: number;
    has_more_page?: boolean;
    total?: number;
  };
}

export type ZohoItemsListResponse = ZohoListResponse & {
  items?: ZohoItemSummary[];
};

export type ZohoItemResponse = { code?: number; message?: string; item?: ZohoItemDetail };


export type ZohoOrganizationsResponse = {
  code?: number;
  message?: string;
  organizations?: ZohoOrganization[];
};

export type ZohoLocationsResponse = {
  code?: number;
  message?: string;
  locations?: ZohoLocationRecord[];
  warehouses?: ZohoWarehouseRecord[];
};
