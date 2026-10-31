-- Up Migration
-- Two meeting upgrades:
--
-- 1. In-person venue — meetings already carry type ('online' | 'in-person');
--    add the physical place details so an in-person meeting can show a real
--    searched location (name, address, coordinates, Google/OSM place id).
--
-- 2. Rich meeting invite card — the chat invitation stops being a plain system
--    sentence and becomes a 'meeting' card message, mirroring the existing
--    poll/order/contact jsonb pattern. The card payload (title, start/end,
--    venue, join link, location) lives in a new messages.meeting_data column.

ALTER TABLE meetings ADD COLUMN IF NOT EXISTS location_name text;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS location_address text;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS location_lat double precision;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS location_lng double precision;
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS location_place_id text;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS meeting_data jsonb;

-- Allow the new 'meeting' message type (card invite).
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_type_check
  CHECK (type IN ('text','image','voice','video','file','location','system','catalog','poll','order','contact','meeting'));

-- Down Migration
ALTER TABLE messages DROP CONSTRAINT IF EXISTS messages_type_check;
ALTER TABLE messages ADD CONSTRAINT messages_type_check
  CHECK (type IN ('text','image','voice','video','file','location','system','catalog','poll','order','contact'));
ALTER TABLE messages DROP COLUMN IF EXISTS meeting_data;
ALTER TABLE meetings DROP COLUMN IF EXISTS location_place_id;
ALTER TABLE meetings DROP COLUMN IF EXISTS location_lng;
ALTER TABLE meetings DROP COLUMN IF EXISTS location_lat;
ALTER TABLE meetings DROP COLUMN IF EXISTS location_address;
ALTER TABLE meetings DROP COLUMN IF EXISTS location_name;
