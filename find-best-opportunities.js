#!/usr/bin/env node

const axios = require('axios');

const API_BASE = 'http://localhost:3000';

// High-potential product keywords to scan
const PRODUCT_KEYWORDS = [
    // Electronics
    { keyword: 'wireless earbuds', category: 'electronics' },
    { keyword: 'phone stand holder', category: 'electronics' },
    { keyword: 'usb c cable braided', category: 'electronics' },
    { keyword: 'portable charger 20000mah', category: 'electronics' },
    { keyword: 'bluetooth speaker waterproof', category: 'electronics' },
    { keyword: 'car phone mount magnetic', category: 'electronics' },
    { keyword: 'laptop stand adjustable', category: 'electronics' },
    { keyword: 'led desk lamp', category: 'electronics' },
    { keyword: 'webcam 1080p', category: 'electronics' },
    { keyword: 'smart watch band', category: 'electronics' },

    // Fitness
    { keyword: 'resistance bands set', category: 'fitness' },
    { keyword: 'yoga mat extra thick', category: 'fitness' },
    { keyword: 'foam roller muscle', category: 'fitness' },
    { keyword: 'jump rope weighted', category: 'fitness' },
    { keyword: 'exercise ball', category: 'fitness' },
    { keyword: 'resistance loop bands', category: 'fitness' },
    { keyword: 'massage ball', category: 'fitness' },
    { keyword: 'workout gloves', category: 'fitness' },
    { keyword: 'ankle weights', category: 'fitness' },
    { keyword: 'water bottle gallon motivational', category: 'fitness' },

    // Home & Garden
    { keyword: 'led strip lights', category: 'home' },
    { keyword: 'desk organizer', category: 'home' },
    { keyword: 'plant pots ceramic', category: 'home' },
    { keyword: 'drawer organizer', category: 'home' },
    { keyword: 'closet organizer', category: 'home' },
    { keyword: 'cable organizer', category: 'home' },
    { keyword: 'shower caddy', category: 'home' },
    { keyword: 'spice rack organizer', category: 'home' },
    { keyword: 'under bed storage', category: 'home' },
    { keyword: 'wall shelves floating', category: 'home' },

    // Beauty
    { keyword: 'makeup brush set', category: 'beauty' },
    { keyword: 'face roller jade', category: 'beauty' },
    { keyword: 'gua sha tool', category: 'beauty' },
    { keyword: 'hair claw clips', category: 'beauty' },
    { keyword: 'lash curler', category: 'beauty' },
    { keyword: 'makeup sponge', category: 'beauty' },
    { keyword: 'nail file set', category: 'beauty' },
    { keyword: 'facial cleansing brush', category: 'beauty' },
    { keyword: 'hair ties no damage', category: 'beauty' },
    { keyword: 'tweezers set', category: 'beauty' },
];

async function scanProduct(keyword, category) {
    try {
        const response = await axios.post(`${API_BASE}/api/scan-opportunity`, {
            keyword,
            category
        });
        return response.data.opportunity;
    } catch (error) {
        console.error(`❌ Error scanning "${keyword}":`, error.message);
        return null;
    }
}

async function findBestOpportunities() {
    console.log('🔍 IMPORT OPPORTUNITY SCANNER - AUTO MODE\n');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log(`📊 Scanning ${PRODUCT_KEYWORDS.length} product keywords...\n`);

    const opportunities = [];
    let scannedCount = 0;

    // Scan all products
    for (const product of PRODUCT_KEYWORDS) {
        scannedCount++;
        process.stdout.write(`\r[${scannedCount}/${PRODUCT_KEYWORDS.length}] Scanning: ${product.keyword.padEnd(40, ' ')}`);

        const opp = await scanProduct(product.keyword, product.category);

        if (opp && opp.score >= 70) { // Only keep good opportunities
            opportunities.push(opp);
        }

        // Small delay to avoid overwhelming APIs
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log('\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log(`✅ Scan complete! Found ${opportunities.length} viable opportunities\n`);

    // Sort by score
    opportunities.sort((a, b) => b.score - a.score);

    // Display TOP 10
    console.log('🏆 TOP 10 OPPORTUNITIES\n');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

    opportunities.slice(0, 10).forEach((opp, index) => {
        const firstOrderProfit = (opp.profit * opp.moq).toFixed(0);

        console.log(`${index + 1}. ${opp.keyword.toUpperCase()}`);
        console.log(`   Score: ${opp.score}/100 ${opp.score >= 90 ? '🔥' : opp.score >= 85 ? '⭐' : '✓'}`);
        console.log(`   Category: ${opp.category}`);
        console.log('');
        console.log(`   📊 DEMAND:`);
        console.log(`      • Search Volume: ${opp.searchVolume.toLocaleString()}/month ${opp.isRising ? '↗ RISING' : ''}`);
        console.log(`      • Competition: ${opp.competitorCount} sellers ${opp.competitorCount < 15 ? '✓ LOW' : ''}`);
        console.log(`      • Avg Rating: ${opp.avgRating}★ ${parseFloat(opp.avgRating) < 4.2 ? '(weak - opportunity!)' : ''}`);
        console.log('');
        console.log(`   💰 PROFIT:`);
        console.log(`      • Factory Cost: $${opp.factoryCost}/unit`);
        console.log(`      • Retail Price: $${opp.retailPrice}/unit`);
        console.log(`      • Your Profit: $${opp.profit}/unit (${opp.margin}% margin)`);
        console.log(`      • MOQ: ${opp.moq} units`);
        console.log(`      • First Order Profit: $${parseInt(firstOrderProfit).toLocaleString()} 💵`);
        console.log('');
        console.log(`   🏭 SUPPLIER:`);
        console.log(`      • ${opp.suppliers[0] || 'China Manufacturer'}`);
        console.log('');
        console.log(`   🎯 ACTION:`);
        console.log(`      1. Search Alibaba: https://www.alibaba.com/trade/search?SearchText=${encodeURIComponent(opp.keyword)}`);
        console.log(`      2. Check Amazon: https://www.amazon.com/s?k=${encodeURIComponent(opp.keyword)}`);
        console.log(`      3. Order samples, then bulk order ${opp.moq} units`);
        console.log(`      4. List on Amazon at ~$${opp.retailPrice}`);
        console.log('');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    });

    // Summary stats
    const totalProfitPotential = opportunities.slice(0, 10).reduce((sum, o) => sum + (o.profit * o.moq), 0);
    const avgScore = Math.round(opportunities.slice(0, 10).reduce((sum, o) => sum + o.score, 0) / 10);
    const avgMargin = Math.round(opportunities.slice(0, 10).reduce((sum, o) => sum + o.margin, 0) / 10);

    console.log('📈 SUMMARY\n');
    console.log(`   • Top 10 Avg Score: ${avgScore}/100`);
    console.log(`   • Avg Profit Margin: ${avgMargin}%`);
    console.log(`   • Total Profit Potential (top 10): $${totalProfitPotential.toLocaleString()}`);
    console.log(`   • Recommended: Start with top 3 opportunities`);
    console.log('');
    console.log('💡 TIP: Focus on opportunities with 85+ scores for best results\n');
}

// Run the scanner
findBestOpportunities().catch(error => {
    console.error('Error:', error.message);
    process.exit(1);
});
