-- Migration: 0000_old_wildside.sql
CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT 'pending' NOT NULL,
	`teacher_name` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`plan_key` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `assignment_unique` ON `assignments` (`account_id`,`plan_key`);--> statement-breakpoint
CREATE TABLE `audit` (
	`id` text PRIMARY KEY NOT NULL,
	`lesson_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`before_json` text,
	`after_json` text,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `lessons` (
	`id` text PRIMARY KEY NOT NULL,
	`student` text NOT NULL,
	`subject` text NOT NULL,
	`teacher_name` text NOT NULL,
	`planned_start` text NOT NULL,
	`planned_end` text NOT NULL,
	`actual_start` text,
	`actual_end` text,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`note` text,
	`chargeable` integer,
	`reviewed_at` text,
	`reviewed_by` text,
	`kind` text DEFAULT 'regular' NOT NULL,
	`series_id` text,
	`replacement_for` text,
	`created_by` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`expires_at` text NOT NULL
);

-- Migration: 0001_luxuriant_hardball.sql
CREATE TABLE `sync_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`month` text NOT NULL,
	`plan_key` text NOT NULL,
	`last_synced_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sync_target_month_plan` ON `sync_targets` (`month`,`plan_key`);

-- Migration: 0002_mysterious_amazoness.sql
CREATE TABLE `plans` (
	`key` text PRIMARY KEY NOT NULL,
	`student` text NOT NULL,
	`subject` text NOT NULL,
	`teacher_name` text NOT NULL,
	`duration` real DEFAULT 1 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `teachers` (
	`name` text PRIMARY KEY NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
DROP TABLE `sync_targets`;

-- Migration: 0003_student_reschedule.sql
ALTER TABLE `accounts` ADD `student_name` text;
--> statement-breakpoint
ALTER TABLE `lessons` ADD `attendance_kind` text;
--> statement-breakpoint
CREATE TABLE `reschedule_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`lesson_id` text NOT NULL,
	`original_start` text NOT NULL,
	`original_end` text NOT NULL,
	`proposed_start` text NOT NULL,
	`proposed_end` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`note` text,
	`requested_by` text NOT NULL,
	`requested_at` text NOT NULL,
	`responded_by` text,
	`responded_at` text
);

-- Migration: 0004_local_credentials.sql
CREATE TABLE `local_credentials` (
	`account_id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`must_change_password` integer DEFAULT true NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_credentials_username_unique` ON `local_credentials` (`username`);
--> statement-breakpoint
CREATE TABLE `login_attempts` (
	`username` text PRIMARY KEY NOT NULL,
	`failures` integer NOT NULL,
	`window_start` text NOT NULL,
	`blocked_until` text
);

-- Migration: 0005_students.sql
CREATE TABLE `students` (
	`name` text PRIMARY KEY NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
INSERT OR IGNORE INTO `students` (`name`, `created_at`)
SELECT DISTINCT `student`, CURRENT_TIMESTAMP FROM `plans` WHERE TRIM(`student`) <> '';
--> statement-breakpoint
INSERT OR IGNORE INTO `students` (`name`, `created_at`)
SELECT DISTINCT `student`, CURRENT_TIMESTAMP FROM `lessons` WHERE TRIM(`student`) <> '';
--> statement-breakpoint
INSERT OR IGNORE INTO `students` (`name`, `created_at`)
SELECT DISTINCT `student_name`, CURRENT_TIMESTAMP FROM `accounts` WHERE `student_name` IS NOT NULL AND TRIM(`student_name`) <> '';

-- Migration: 0006_student_identity.sql
CREATE TABLE `students_next` (
	`name` text PRIMARY KEY NOT NULL,
	`name_key` text NOT NULL,
	`active` integer NOT NULL DEFAULT 1,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `students_next_name_key_unique` ON `students_next` (`name_key`);
--> statement-breakpoint
INSERT OR IGNORE INTO `students_next` (`name`, `name_key`, `active`, `created_at`)
SELECT `name`, lower(replace(replace(trim(`name`), ' ', ''), char(9), '')), 1, `created_at`
FROM `students`
ORDER BY CASE WHEN `name` LIKE '% %' THEN 0 ELSE 1 END, `name`;
--> statement-breakpoint
UPDATE `plans`
SET `student` = (SELECT `name` FROM `students_next` WHERE `name_key` = lower(replace(replace(trim(`plans`.`student`), ' ', ''), char(9), ''))),
    `key` = (SELECT `name` FROM `students_next` WHERE `name_key` = lower(replace(replace(trim(`plans`.`student`), ' ', ''), char(9), ''))) || '|' || `subject`
WHERE EXISTS (SELECT 1 FROM `students_next` WHERE `name_key` = lower(replace(replace(trim(`plans`.`student`), ' ', ''), char(9), '')) AND `name` <> `plans`.`student`);
--> statement-breakpoint
UPDATE `lessons`
SET `student` = (SELECT `name` FROM `students_next` WHERE `name_key` = lower(replace(replace(trim(`lessons`.`student`), ' ', ''), char(9), '')))
WHERE EXISTS (SELECT 1 FROM `students_next` WHERE `name_key` = lower(replace(replace(trim(`lessons`.`student`), ' ', ''), char(9), '')) AND `name` <> `lessons`.`student`);
--> statement-breakpoint
UPDATE `accounts`
SET `student_name` = (SELECT `name` FROM `students_next` WHERE `name_key` = lower(replace(replace(trim(`accounts`.`student_name`), ' ', ''), char(9), '')))
WHERE EXISTS (SELECT 1 FROM `students_next` WHERE `name_key` = lower(replace(replace(trim(`accounts`.`student_name`), ' ', ''), char(9), '')) AND `name` <> `accounts`.`student_name`);
--> statement-breakpoint
UPDATE `assignments`
SET `plan_key` = (SELECT `name` FROM `students_next` WHERE `name_key` = lower(replace(replace(trim(substr(`assignments`.`plan_key`, 1, instr(`assignments`.`plan_key`, '|') - 1)), ' ', ''), char(9), ''))) || substr(`plan_key`, instr(`plan_key`, '|'))
WHERE instr(`plan_key`, '|') > 0 AND EXISTS (
  SELECT 1 FROM `students_next`
  WHERE `name_key` = lower(replace(replace(trim(substr(`assignments`.`plan_key`, 1, instr(`assignments`.`plan_key`, '|') - 1)), ' ', ''), char(9), ''))
    AND `name` <> substr(`assignments`.`plan_key`, 1, instr(`assignments`.`plan_key`, '|') - 1)
);
--> statement-breakpoint
DROP TABLE `students`;
--> statement-breakpoint
ALTER TABLE `students_next` RENAME TO `students`;
--> statement-breakpoint
DROP INDEX `students_next_name_key_unique`;
--> statement-breakpoint
CREATE UNIQUE INDEX `students_name_key_unique` ON `students` (`name_key`);

-- Migration: 0007_puzzling_red_hulk.sql
CREATE TABLE `homework` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`subject` text NOT NULL,
	`description` text NOT NULL,
	`starts_at` text NOT NULL,
	`due_at` text NOT NULL,
	`attachment_file_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `homework_recipients` (
	`id` text PRIMARY KEY NOT NULL,
	`homework_id` text NOT NULL,
	`student_name` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `homework_recipient_unique` ON `homework_recipients` (`homework_id`,`student_name`);--> statement-breakpoint
CREATE TABLE `homework_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`homework_id` text NOT NULL,
	`student_name` text NOT NULL,
	`file_id` text NOT NULL,
	`submitted_at` text NOT NULL,
	`late` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `homework_submissions_file_id_unique` ON `homework_submissions` (`file_id`);--> statement-breakpoint
CREATE TABLE `material_recipients` (
	`id` text PRIMARY KEY NOT NULL,
	`material_id` text NOT NULL,
	`student_name` text NOT NULL,
	`subject` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `material_recipient_unique` ON `material_recipients` (`material_id`,`student_name`,`subject`);--> statement-breakpoint
CREATE TABLE `pdf_files` (
	`id` text PRIMARY KEY NOT NULL,
	`object_key` text NOT NULL,
	`owner_id` text NOT NULL,
	`kind` text NOT NULL,
	`context_id` text,
	`filename` text NOT NULL,
	`bytes` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pdf_files_object_key_unique` ON `pdf_files` (`object_key`);--> statement-breakpoint
CREATE TABLE `storage_quota` (
	`id` integer PRIMARY KEY NOT NULL,
	`used_bytes` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `study_blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`title` text NOT NULL,
	`subject` text,
	`note` text,
	`starts_at` text NOT NULL,
	`ends_at` text NOT NULL,
	`homework_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `teaching_materials` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`file_id` text NOT NULL,
	`created_at` text NOT NULL
);

-- Migration: 0008_parched_dreaming_celestial.sql
ALTER TABLE `homework` ADD `max_score` real;--> statement-breakpoint
ALTER TABLE `homework_recipients` ADD `score` real;--> statement-breakpoint
ALTER TABLE `homework_recipients` ADD `scored_at` text;--> statement-breakpoint
ALTER TABLE `homework_recipients` ADD `scored_by` text;

-- Migration: 0009_fixed_scream.sql
ALTER TABLE `accounts` ADD `name_confirmed_at` text;--> statement-breakpoint
ALTER TABLE `plans` ADD `online_link` text;--> statement-breakpoint
UPDATE `accounts` SET `name_confirmed_at` = `created_at` WHERE `name_confirmed_at` IS NULL;

-- Migration: 0010_familiar_albert_cleary.sql
CREATE TABLE `classroom_announcements` (
	`id` text PRIMARY KEY NOT NULL,
	`classroom_id` text NOT NULL,
	`author_id` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `classroom_members` (
	`id` text PRIMARY KEY NOT NULL,
	`classroom_id` text NOT NULL,
	`student_name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `classroom_member_unique` ON `classroom_members` (`classroom_id`,`student_name`);--> statement-breakpoint
CREATE TABLE `classrooms` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`subject` text NOT NULL,
	`teacher_name` text NOT NULL,
	`created_by` text NOT NULL,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `homework` ADD `classroom_id` text;--> statement-breakpoint
ALTER TABLE `teaching_materials` ADD `classroom_id` text;

-- Migration: 0011_account_identity.sql
CREATE TABLE `google_identities` (
	`subject` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`email` text NOT NULL,
	`linked_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `google_identities_account_id_unique` ON `google_identities` (`account_id`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `disabled_at` text;
--> statement-breakpoint
INSERT INTO google_identities (subject, account_id, email, linked_at)
SELECT id, id, email, created_at FROM accounts WHERE id NOT LIKE 'local:%' AND email <> '';

-- Migration: 0012_spotty_preak.sql
CREATE TABLE `academic_terms` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`is_current` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `academic_terms_name_unique` ON `academic_terms` (`name`);--> statement-breakpoint
ALTER TABLE `classrooms` ADD `term_id` text;

-- Migration: 0013_massive_hardball.sql
ALTER TABLE `reschedule_requests` ADD `requested_role` text DEFAULT 'teacher' NOT NULL;

-- Migration: 0014_unified_login.sql
ALTER TABLE `accounts` ADD `pending_expires_at` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `activated_at` text;--> statement-breakpoint
ALTER TABLE `accounts` ADD `activation_reason` text;

-- Migration: 0015_lesson_notifications.sql
CREATE TABLE `notification_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lock_until` text,
	`next_attempt_at` text NOT NULL,
	`sent_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_delivery_unique` ON `notification_deliveries` (`item_id`,`subscription_id`);--> statement-breakpoint
CREATE INDEX `notification_delivery_due_idx` ON `notification_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `notification_items` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`lesson_id` text NOT NULL,
	`planned_start` text NOT NULL,
	`offset_minutes` integer NOT NULL,
	`due_at` text NOT NULL,
	`created_at` text NOT NULL,
	`read_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notification_item_unique` ON `notification_items` (`account_id`,`lesson_id`,`planned_start`,`offset_minutes`);--> statement-breakpoint
CREATE INDEX `notification_account_idx` ON `notification_items` (`account_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `notification_runtime` (
	`id` integer PRIMARY KEY NOT NULL,
	`last_dispatch_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`language` text DEFAULT 'zh' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_test_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `push_subscriptions_endpoint_unique` ON `push_subscriptions` (`endpoint`);--> statement-breakpoint
CREATE INDEX `push_account_idx` ON `push_subscriptions` (`account_id`);
