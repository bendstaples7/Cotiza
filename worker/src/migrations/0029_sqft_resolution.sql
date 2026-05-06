-- Migration: 0029_sqft_resolution.sql
-- Adds sqft_resolution_json column to quote_drafts for storing the tiered
-- resolution result (value, source tier, confidence, metadata) and any
-- manual override alongside the original automated resolution.
-- IDEMPOTENCY: column may already exist; deploy will apply manually if needed
ALTER TABLE quote_drafts ADD COLUMN sqft_resolution_json TEXT DEFAULT NULL;
