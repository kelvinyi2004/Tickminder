CREATE TABLE `ai_job_events` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`event_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`payload` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_job_events_job_idx` ON `ai_job_events` (`job_id`);--> statement-breakpoint
CREATE INDEX `ai_job_events_created_at_idx` ON `ai_job_events` (`created_at`);--> statement-breakpoint
CREATE TABLE `ai_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text,
	`type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`payload` text NOT NULL,
	`result` text,
	`error` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`lock_until` text,
	`locked_by` text,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`completed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ai_jobs_idempotency_key_unique` ON `ai_jobs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `ai_jobs_status_lock_idx` ON `ai_jobs` (`status`,`lock_until`,`created_at`);--> statement-breakpoint
CREATE INDEX `ai_jobs_created_by_idx` ON `ai_jobs` (`created_by`);