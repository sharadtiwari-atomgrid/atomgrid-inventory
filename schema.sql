create extension if not exists pgcrypto;

create table if not exists inventory_products (
  id uuid primary key default gen_random_uuid(),
  catalogue_name text not null unique,
  aliases jsonb not null default '[]'::jsonb,
  molecule_name text,
  hsn text,
  registration_status text,
  uom text not null default 'KG',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists inventory_base_stock (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references inventory_products(id) on delete cascade,
  base_date date not null,
  base_quantity numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(product_id)
);

create table if not exists inventory_domestic_movements (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique,
  product_id uuid references inventory_products(id) on delete set null,
  source_product_name text not null,
  movement_type text not null check (movement_type in ('INWARD','OUTWARD')),
  actual_date date not null,
  quantity numeric not null default 0,
  job_no text,
  status text,
  origin_type text,
  destination_type text,
  created_at timestamptz not null default now()
);

create index if not exists inventory_domestic_date_idx
on inventory_domestic_movements(actual_date);
create index if not exists inventory_domestic_product_idx
on inventory_domestic_movements(product_id);

create table if not exists inventory_warehouse_movements (
  id uuid primary key default gen_random_uuid(),
  source_key text not null unique,
  product_id uuid references inventory_products(id) on delete set null,
  source_product_name text not null,
  movement_type text not null check (movement_type in ('INWARD','OUTWARD')),
  movement_date date not null,
  quantity numeric not null default 0,
  reference_no text,
  created_at timestamptz not null default now()
);

create index if not exists inventory_warehouse_date_idx
on inventory_warehouse_movements(movement_date);
create index if not exists inventory_warehouse_product_idx
on inventory_warehouse_movements(product_id);

create table if not exists inventory_warehouse_eod (
  id uuid primary key default gen_random_uuid(),
  snapshot_date date not null,
  product_id uuid references inventory_products(id) on delete set null,
  source_product_name text not null,
  physical_closing_stock numeric,
  created_at timestamptz not null default now(),
  unique(snapshot_date, product_id)
);

create index if not exists inventory_eod_date_idx
on inventory_warehouse_eod(snapshot_date);

create or replace function inventory_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at=now();
  return new;
end;
$$;

drop trigger if exists inventory_products_updated_at on inventory_products;
create trigger inventory_products_updated_at before update on inventory_products
for each row execute function inventory_updated_at();

drop trigger if exists inventory_base_updated_at on inventory_base_stock;
create trigger inventory_base_updated_at before update on inventory_base_stock
for each row execute function inventory_updated_at();

alter table inventory_products enable row level security;
alter table inventory_base_stock enable row level security;
alter table inventory_domestic_movements enable row level security;
alter table inventory_warehouse_movements enable row level security;
alter table inventory_warehouse_eod enable row level security;
