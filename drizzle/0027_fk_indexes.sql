CREATE INDEX IF NOT EXISTS "alerts_plan_idx" ON "alerts" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "alerts_equipment_idx" ON "alerts" USING btree ("equipment_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_user_idx" ON "audit_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "equipment_maintenance_type_idx" ON "equipment_maintenance_types" USING btree ("maintenance_type_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fuel_movements_fuel_type_idx" ON "fuel_movements" USING btree ("fuel_type_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "fuel_movements_responsible_employee_idx" ON "fuel_movements" USING btree ("responsible_employee_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "plan_maintenance_type_idx" ON "maintenance_plans" USING btree ("maintenance_type_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "material_request_items_product_idx" ON "material_request_items" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "meter_front_idx" ON "meter_readings" USING btree ("service_front_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_created_by_idx" ON "tasks" USING btree ("created_by");