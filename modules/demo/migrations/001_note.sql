create schema if not exists demo;
create table if not exists demo.note(id serial primary key, body text not null, created_at timestamptz default now());
