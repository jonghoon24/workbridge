/*
  Warnings:

  - You are about to drop the `PricingAnalysis` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "PricingAnalysis" DROP CONSTRAINT "PricingAnalysis_projectId_fkey";

-- DropTable
DROP TABLE "PricingAnalysis";
