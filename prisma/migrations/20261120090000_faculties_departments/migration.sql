-- Faculties & departments (temporary codes until the portal's real ones are known),
-- DEAN role, minimum instalments per department.

-- AlterEnum
ALTER TYPE "AdminRole" ADD VALUE 'DEAN';

-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN     "faculties" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "Faculty" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Faculty_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Department" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "facultyId" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "needsReview" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Department_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Faculty_code_key" ON "Faculty"("code");

-- CreateIndex
CREATE UNIQUE INDEX "Department_code_key" ON "Department"("code");

-- CreateIndex
CREATE INDEX "Department_facultyId_idx" ON "Department"("facultyId");

-- AddForeignKey
ALTER TABLE "Department" ADD CONSTRAINT "Department_facultyId_fkey" FOREIGN KEY ("facultyId") REFERENCES "Faculty"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- No Data API access (see 20261118140000_enable_rls)
ALTER TABLE "Faculty" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Department" ENABLE ROW LEVEL SECURITY;

-- Starting list (from unimak.edu.sl, undergraduate + postgraduate pages)
INSERT INTO "Faculty" (id, code, name, "updatedAt") VALUES
  (gen_random_uuid(), 'FAC-AGRIC', 'Faculty of Agriculture and Food Sciences', now()),
  (gen_random_uuid(), 'FAC-COMMERCE', 'Faculty of Commerce and Management', now()),
  (gen_random_uuid(), 'FAC-EDUCATION', 'Faculty of Education', now()),
  (gen_random_uuid(), 'FAC-LAW-HUM', 'Faculty of Law and Humanities', now()),
  (gen_random_uuid(), 'FAC-MASSCOM-CS', 'Faculty of Mass Communication and Computer Science', now()),
  (gen_random_uuid(), 'FAC-SOCIAL-SCI', 'Faculty of Social Sciences', now()),
  (gen_random_uuid(), 'FAC-NURSING-AHS', 'Faculty of Nursing and Allied Health Sciences', now()),
  (gen_random_uuid(), 'FAC-PURE-SCI', 'Faculty of Pure Sciences', now()),
  (gen_random_uuid(), 'FAC-POSTGRAD', 'Postgraduate Studies', now()),
  (gen_random_uuid(), 'FAC-DIPLOMA', 'Diploma & Certificate Studies', now())
ON CONFLICT (code) DO NOTHING;

INSERT INTO "Department" (id, code, name, "facultyId", "updatedAt")
SELECT gen_random_uuid(), d.code, d.name, f.id, now()
FROM (VALUES
  ('AGRIC-FOOD', 'Agriculture and Food Sciences', 'FAC-AGRIC'),
  ('ACCOUNTING-FIN', 'Accounting and Finance', 'FAC-COMMERCE'),
  ('BANKING-FIN', 'Banking and Finance', 'FAC-COMMERCE'),
  ('BUS-ADMIN', 'Business Administration and Management', 'FAC-COMMERCE'),
  ('HRM', 'Human Resource Management', 'FAC-COMMERCE'),
  ('PROCUREMENT', 'Procurement, Logistics and Supply Chain Management', 'FAC-COMMERCE'),
  ('EDUCATION', 'Education', 'FAC-EDUCATION'),
  ('SPECIAL-NEEDS', 'Special Needs', 'FAC-EDUCATION'),
  ('LAW', 'Law', 'FAC-LAW-HUM'),
  ('PHILOSOPHY', 'Philosophy', 'FAC-LAW-HUM'),
  ('POL-SCI-IR', 'Political Science and International Relations', 'FAC-LAW-HUM'),
  ('COMPUTER-SCI', 'Computer Science', 'FAC-MASSCOM-CS'),
  ('MASS-COMM', 'Mass Communication', 'FAC-MASSCOM-CS'),
  ('DEV-STUDIES', 'Development Studies', 'FAC-SOCIAL-SCI'),
  ('ECONOMICS', 'Economics', 'FAC-SOCIAL-SCI'),
  ('PUB-ADMIN', 'Public Administration and Management', 'FAC-SOCIAL-SCI'),
  ('SOCIAL-WORK', 'Social Work', 'FAC-SOCIAL-SCI'),
  ('CLIN-PSYCH', 'Clinical Psychology', 'FAC-NURSING-AHS'),
  ('NURSING', 'Nursing', 'FAC-NURSING-AHS'),
  ('PUBLIC-HEALTH', 'Public Health', 'FAC-NURSING-AHS'),
  ('PURE-SCI', 'Pure Sciences', 'FAC-PURE-SCI'),
  ('PG-MBA', 'Master of Business Administration (MBA)', 'FAC-POSTGRAD'),
  ('PG-MA-SD', 'MA Sustainable Development', 'FAC-POSTGRAD'),
  ('PG-LLM', 'Master of Laws (LLM)', 'FAC-POSTGRAD'),
  ('PG-MPH', 'MSc Public Health (MPH)', 'FAC-POSTGRAD'),
  ('PG-MED', 'Master in Education (MEd)', 'FAC-POSTGRAD'),
  ('PG-PGDE', 'Postgraduate Diploma in Education (PGDE)', 'FAC-POSTGRAD'),
  ('PG-PGDQA', 'Postgraduate Diploma in Quality Assurance (PGDQA)', 'FAC-POSTGRAD'),
  ('PG-PHD-EDU', 'PhD in Education', 'FAC-POSTGRAD'),
  ('PG-PHD-SD', 'PhD in Sustainable Development', 'FAC-POSTGRAD'),
  ('DIP-ICT', 'Information and Communication Technology', 'FAC-DIPLOMA'),
  ('DIP-PEACE', 'Peace Studies', 'FAC-DIPLOMA'),
  ('DIP-DEV-COMM', 'Development Communication', 'FAC-DIPLOMA'),
  ('DIP-HRM', 'Human Resource Management (Diploma)', 'FAC-DIPLOMA'),
  ('DIP-SPECIAL-ED', 'Special Education', 'FAC-DIPLOMA'),
  ('DIP-BUS-ADMIN', 'Business Administration (Diploma)', 'FAC-DIPLOMA'),
  ('DIP-PARALEGAL', 'Paralegal Studies', 'FAC-DIPLOMA'),
  ('DIP-GOVERNANCE', 'Good Governance and Human Rights', 'FAC-DIPLOMA'),
  ('DIP-AGRIC', 'Agriculture (Diploma)', 'FAC-DIPLOMA'),
  ('DIP-RELIGIOUS', 'Religious Studies', 'FAC-DIPLOMA'),
  ('HTC-INT-SCI', 'HTC – Integration Sciences', 'FAC-DIPLOMA'),
  ('HTC-MATHS', 'HTC – Mathematics', 'FAC-DIPLOMA'),
  ('HTC-LANG-ARTS', 'HTC – Language Arts', 'FAC-DIPLOMA'),
  ('CERT-MENTAL-HEALTH', 'Mental Health Capacity Building (Certificate)', 'FAC-DIPLOMA')
) AS d(code, name, faculty)
JOIN "Faculty" f ON f.code = d.faculty
ON CONFLICT (code) DO NOTHING;

-- The mock portal's department codes become the temporary codes.
UPDATE "Payer" SET department = 'COMPUTER-SCI' WHERE department = 'COMPUTING';
UPDATE "Payer" SET department = 'NURSING' WHERE department = 'HEALTH';
UPDATE "RateRule" SET department = 'COMPUTER-SCI' WHERE department = 'COMPUTING';
UPDATE "RateRule" SET department = 'NURSING' WHERE department = 'HEALTH';
UPDATE "EligibilityRule" SET department = 'COMPUTER-SCI' WHERE department = 'COMPUTING';
UPDATE "EligibilityRule" SET department = 'NURSING' WHERE department = 'HEALTH';
UPDATE "AdminUser" SET departments = array_replace(array_replace(departments, 'COMPUTING', 'COMPUTER-SCI'), 'HEALTH', 'NURSING');

-- Minimum instalments: program → department (the seeded program rules map 1:1).
DROP INDEX "InstalmentRule_feeId_programCode_key";
ALTER TABLE "InstalmentRule" RENAME COLUMN "programCode" TO "department";
UPDATE "InstalmentRule" SET department = CASE department
  WHEN 'BSC-NUR' THEN 'NURSING'
  WHEN 'BSC-CS' THEN 'COMPUTER-SCI'
  WHEN 'BSC-IT' THEN 'COMPUTER-SCI'
  ELSE department END;
-- Two programs of one department: keep the higher minimum.
DELETE FROM "InstalmentRule" a USING "InstalmentRule" b
WHERE a."feeId" = b."feeId" AND a.department = b.department
  AND (a."minInstalment" < b."minInstalment" OR (a."minInstalment" = b."minInstalment" AND a.id > b.id));
CREATE UNIQUE INDEX "InstalmentRule_feeId_department_key" ON "InstalmentRule"("feeId", "department");

-- Any other department code already in use: register it for review.
INSERT INTO "Department" (id, code, name, "needsReview", "updatedAt")
SELECT gen_random_uuid(), c, c, true, now() FROM (
  SELECT department AS c FROM "Payer" UNION SELECT department FROM "RateRule"
  UNION SELECT department FROM "EligibilityRule" UNION SELECT department FROM "InstalmentRule"
  UNION SELECT unnest(departments) FROM "AdminUser"
) used WHERE c IS NOT NULL AND c <> ''
ON CONFLICT (code) DO NOTHING;
