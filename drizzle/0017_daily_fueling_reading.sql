ALTER TABLE "daily_record_fuelings" ALTER COLUMN "location" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_record_fuelings" ADD COLUMN "meter_reading" double precision;