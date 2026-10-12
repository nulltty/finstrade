import { AggregatedTokenMetrics } from './aggregator.js';
import { env, scoringWeights } from '../config/index.js';
import { prisma } from '../db/prisma.js';
import { logger } from './logger.js';

export interface ScoreResult {
  totalScore: number;
  isHardFail: boolean;
  hardFailReasons: string[];
  breakdown: {
    liquidity: { score: number; weight: number; contribution: number; note: string };
    holderConcentration: { score: number; weight: number; contribution: number; note: string };
    contractSafety: { score: number; weight: number; contribution: number; note: string };
    volumeMcRatio: { score: number; weight: number; contribution: number; note: string };
    tokenAgeHolders: { score: number; weight: number; contribution: number; note: string };
  };
  passedThreshold: boolean;
}

export class ScoringEngine {
  calculateScore(metrics: AggregatedTokenMetrics): ScoreResult {
    const hardFailReasons: string[] = [];
    let isHardFail = false;

    // 1. Check Hard Fail Rules
    if (metrics.isHoneypot) {
      isHardFail = true;
      hardFailReasons.push('Honeypot detected by GoPlus Security API');
    }

    if (!metrics.isLiquidityLocked && metrics.liquidityUsd < env.HARD_FAIL_MIN_LIQUIDITY_USD) {
      isHardFail = true;
      hardFailReasons.push(`Unlocked liquidity below hard-fail floor ($${metrics.liquidityUsd.toFixed(0)} < $${env.HARD_FAIL_MIN_LIQUIDITY_USD})`);
    }

    if (!metrics.contractVerified && metrics.liquidityUsd === 0) {
      isHardFail = true;
      hardFailReasons.push('Contract could not be verified and zero liquidity reported');
    }

    // 2. Factor: Liquidity locked & size (25%)
    let rawLiquidityScore = 0;
    let liquidityNote = '';
    if (!metrics.isLiquidityLocked || metrics.liquidityUsd < env.MIN_LIQUIDITY_USD) {
      rawLiquidityScore = 0;
      liquidityNote = metrics.isLiquidityLocked
        ? `Liquidity too low ($${metrics.liquidityUsd.toFixed(0)} < $${env.MIN_LIQUIDITY_USD})`
        : 'Liquidity is not locked';
    } else {
      // Scaled from $10k (50 pts) to $100k+ (100 pts)
      const scaled = 50 + Math.min(50, ((metrics.liquidityUsd - env.MIN_LIQUIDITY_USD) / 90000) * 50);
      rawLiquidityScore = Math.round(scaled);
      liquidityNote = `Locked ${metrics.lockedPercentage}% with $${metrics.liquidityUsd.toLocaleString()} pool`;
    }

    // 3. Factor: Top 10 Holder Concentration (20%)
    // Lower concentration is better. < 20% = 100, > 70% = 0
    let rawHolderScore = 0;
    let holderNote = '';
    if (metrics.top10HoldersPercent <= 20) {
      rawHolderScore = 100;
      holderNote = `Well distributed (Top 10 hold ${metrics.top10HoldersPercent.toFixed(1)}%)`;
    } else if (metrics.top10HoldersPercent >= 70) {
      rawHolderScore = 0;
      holderNote = `Highly concentrated (Top 10 hold ${metrics.top10HoldersPercent.toFixed(1)}%)`;
    } else {
      rawHolderScore = Math.round(100 - ((metrics.top10HoldersPercent - 20) / 50) * 100);
      holderNote = `Top 10 hold ${metrics.top10HoldersPercent.toFixed(1)}%`;
    }

    // 4. Factor: Contract Safety (25%)
    let rawSafetyScore = 100;
    const safetyIssues: string[] = [];
    if (metrics.isHoneypot) {
      rawSafetyScore = 0;
      safetyIssues.push('Honeypot');
    } else {
      if (metrics.hasMintFunction) {
        rawSafetyScore -= 40;
        safetyIssues.push('Mint function active');
      }
      if (!metrics.isOwnershipRenounced) {
        rawSafetyScore -= 20;
        safetyIssues.push('Ownership not renounced');
      }
      if (!metrics.contractVerified) {
        rawSafetyScore -= 20;
        safetyIssues.push('Unverified contract');
      }
    }
    rawSafetyScore = Math.max(0, rawSafetyScore);
    const safetyNote = safetyIssues.length === 0 ? 'Clean contract (no honeypot/mint/renounced)' : safetyIssues.join(', ');

    // 5. Factor: Volume / Market Cap Ratio (15%)
    let rawVolumeScore = 0;
    let volumeNote = '';
    const ratio = metrics.volumeMcRatio;
    if (ratio < 0.02) {
      rawVolumeScore = 10;
      volumeNote = `Very low volume/MC ratio (${(ratio * 100).toFixed(1)}%)`;
    } else if (ratio >= 0.1 && ratio <= 1.5) {
      rawVolumeScore = 100;
      volumeNote = `Healthy volume/MC ratio (${(ratio * 100).toFixed(1)}%)`;
    } else if (ratio > 1.5) {
      rawVolumeScore = 70;
      volumeNote = `High wash trading suspicion ratio (${(ratio * 100).toFixed(1)}%)`;
    } else {
      rawVolumeScore = Math.round((ratio / 0.1) * 90 + 10);
      volumeNote = `Moderate volume/MC ratio (${(ratio * 100).toFixed(1)}%)`;
    }

    // 6. Factor: Token Age & Holder Count (15%)
    let rawAgeScore = 100;
    const ageNotes: string[] = [];
    if (metrics.tokenAgeHours < 1) {
      rawAgeScore -= 40;
      ageNotes.push(`<1 hour old (${(metrics.tokenAgeHours * 60).toFixed(0)}m)`);
    } else if (metrics.tokenAgeHours < 6) {
      rawAgeScore -= 20;
      ageNotes.push(`${metrics.tokenAgeHours.toFixed(1)}h old`);
    } else {
      ageNotes.push(`Mature (${metrics.tokenAgeHours.toFixed(1)}h)`);
    }

    if (metrics.holderCount < 100) {
      rawAgeScore -= 30;
      ageNotes.push(`${metrics.holderCount} holders`);
    } else {
      ageNotes.push(`${metrics.holderCount} holders`);
    }
    rawAgeScore = Math.max(0, rawAgeScore);
    const ageNote = ageNotes.join(' | ');

    // Calculate Weighted Sum
    const weightedSum =
      rawLiquidityScore * scoringWeights.liquidity +
      rawHolderScore * scoringWeights.holderConcentration +
      rawSafetyScore * scoringWeights.contractSafety +
      rawVolumeScore * scoringWeights.volumeMcRatio +
      rawAgeScore * scoringWeights.tokenAgeHolders;

    let finalScore = Math.round(weightedSum);
    if (isHardFail) {
      finalScore = Math.min(finalScore, 15); // force below threshold
    }

    const passedThreshold = !isHardFail && finalScore >= env.SCORING_THRESHOLD;

    return {
      totalScore: finalScore,
      isHardFail,
      hardFailReasons,
      breakdown: {
        liquidity: {
          score: rawLiquidityScore,
          weight: scoringWeights.liquidity,
          contribution: Math.round(rawLiquidityScore * scoringWeights.liquidity),
          note: liquidityNote,
        },
        holderConcentration: {
          score: rawHolderScore,
          weight: scoringWeights.holderConcentration,
          contribution: Math.round(rawHolderScore * scoringWeights.holderConcentration),
          note: holderNote,
        },
        contractSafety: {
          score: rawSafetyScore,
          weight: scoringWeights.contractSafety,
          contribution: Math.round(rawSafetyScore * scoringWeights.contractSafety),
          note: safetyNote,
        },
        volumeMcRatio: {
          score: rawVolumeScore,
          weight: scoringWeights.volumeMcRatio,
          contribution: Math.round(rawVolumeScore * scoringWeights.volumeMcRatio),
          note: volumeNote,
        },
        tokenAgeHolders: {
          score: rawAgeScore,
          weight: scoringWeights.tokenAgeHolders,
          contribution: Math.round(rawAgeScore * scoringWeights.tokenAgeHolders),
          note: ageNote,
        },
      },
      passedThreshold,
    };
  }

  /**
   * Persist score in DB
   */
  async saveScore(signalId: string, result: ScoreResult) {
    const scoreRecord = await prisma.score.upsert({
      where: { signalId },
      create: {
        signalId,
        totalScore: result.totalScore,
        isHardFail: result.isHardFail,
        hardFailReasons: result.hardFailReasons,
        breakdown: result.breakdown as any,
      },
      update: {
        totalScore: result.totalScore,
        isHardFail: result.isHardFail,
        hardFailReasons: result.hardFailReasons,
        breakdown: result.breakdown as any,
      },
    });

    await prisma.signal.update({
      where: { id: signalId },
      data: {
        status: result.passedThreshold ? 'pending_approval' : 'scored',
      },
    });

    logger.info(
      { signalId, totalScore: result.totalScore, isHardFail: result.isHardFail, passedThreshold: result.passedThreshold },
      'Signal scored'
    );

    return scoreRecord;
  }
}

export const scoringEngine = new ScoringEngine();
