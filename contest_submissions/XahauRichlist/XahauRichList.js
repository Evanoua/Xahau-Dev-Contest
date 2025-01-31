const xrpl = require("xrpl");
const fs = require("fs");
const path = require("path");
const client = new xrpl.Client("wss://xahau.network");

let lastLedgerCount = 0;
let stableCountIterations = 0;

async function main() {
    try {
        await client.connect();

        const { result: { ledger_index: latestLedgerIndex } } = await client.request({
            command: "ledger",
            ledger_index: "validated",
            api_version: 1
        });

        console.log(`Using Latest Validated Ledger Index: ${latestLedgerIndex}`);

        const ranges = [
            { range: "0 - 10", min: 0, max: 10, count: 0, sum: 0 },
            { range: "10 - 100", min: 10, max: 100, count: 0, sum: 0 },
            { range: "100 - 1000", min: 100, max: 1000, count: 0, sum: 0 },
            { range: "1000 - 5000", min: 1000, max: 5000, count: 0, sum: 0 },
            { range: "5000 - 20000", min: 5000, max: 20000, count: 0, sum: 0 },
            { range: "20000 - 100000", min: 20000, max: 100000, count: 0, sum: 0 },
            { range: "100000+", min: 100000, max: Infinity, count: 0, sum: 0 }
        ];

        const state = new Map();
        const processedLedgers = new Set();

        const outputFolder = path.join(__dirname, "XahauLedgerFetched");
        if (!fs.existsSync(outputFolder)) {
            fs.mkdirSync(outputFolder);
        }

        let lastAccountCount = state.size;
        let stableCountIterations = 0;
        const STABILITY_THRESHOLD = 50; // Maximum acceptable account increase
        const STABILITY_TIME = 10000; // 10 seconds in milliseconds

        function updateSummary() {
            const currentRanges = [
                { range: "0 - 10", min: 0, max: 10, count: 0, sum: 0 },
            { range: "10 - 100", min: 10, max: 100, count: 0, sum: 0 },
            { range: "100 - 1000", min: 100, max: 1000, count: 0, sum: 0 },
            { range: "1000 - 5000", min: 1000, max: 5000, count: 0, sum: 0 },
            { range: "5000 - 20000", min: 5000, max: 20000, count: 0, sum: 0 },
            { range: "20000 - 100000", min: 20000, max: 100000, count: 0, sum: 0 },
            { range: "100000+", min: 100000, max: Infinity, count: 0, sum: 0 }
            ];
        
            for (const entry of state.values()) {
                const balance = Number(entry.Balance) / 1000000; // Convert drops to token
                currentRanges.forEach((r) => {
                    if (balance >= r.min && balance < r.max) {
                        r.count++;
                        r.sum += balance;
                    }
                });
            }
        
            // Calculate total sum of all ranges
            const totalSum = currentRanges.reduce((acc, r) => acc + r.sum, 0);
        
            // Add percentage of total for each range
            currentRanges.forEach((r) => {
                r.percentageOfTotal = totalSum > 0 ? (r.sum / totalSum) * 100 : 0;
            });
        
            const intermediateSummary = {
                totalUniqueAccounts: state.size,
                processedLedgers: Array.from(processedLedgers),
                balanceRanges: currentRanges,
                lastUpdate: new Date().toISOString()
            };
        
            fs.writeFileSync(
                path.join(outputFolder, "live_summary.json"),
                JSON.stringify(intermediateSummary, null, 2)
            );
        
            const accountDifference = Math.abs(state.size - lastAccountCount);
        
            if (accountDifference < STABILITY_THRESHOLD) {
                stableCountIterations++;
                if (stableCountIterations * 15000 >= STABILITY_TIME) {
                    // Generate unique `complete_summaryX.json` file
                    const existingSummaries = fs.readdirSync(outputFolder)
                        .filter(file => file.startsWith("complete_summary") && file.endsWith(".json"))
                        .map(file => parseInt(file.match(/\d+/)?.[0] || 0, 10))
                        .sort((a, b) => a - b);
        
                    const nextSummaryNumber = (existingSummaries.pop() || 0) + 1;
                    const completeSummaryFile = `complete_summary${nextSummaryNumber}.json`;
        
                    fs.copyFileSync(
                        path.join(outputFolder, "live_summary.json"),
                        path.join(outputFolder, completeSummaryFile)
                    );
        
                    fs.readdirSync(outputFolder).forEach(file => {
                        if (file.startsWith('ledger_')) {
                            fs.unlinkSync(path.join(outputFolder, file));
                        }
                    });
        
                    console.log("\nAccount count has stabilized!");
                    console.log(`Final unique accounts: ${state.size}`);
                    console.log(`Summary saved as ${completeSummaryFile}`);
                    console.log("All ledger files cleaned up.");
                    process.exit(0);
                }
            } else {
                stableCountIterations = 0;
            }
        
            lastAccountCount = state.size;
        }
        

        setInterval(updateSummary, 15000);

        async function fetchFullLedger(ledgerIndex) {
            const ledgerFileName = path.join(outputFolder, `ledger_${ledgerIndex}.json`);

            if (fs.existsSync(ledgerFileName)) {
                console.log(`Loading cached ledger ${ledgerIndex}`);
                const cachedData = JSON.parse(fs.readFileSync(ledgerFileName));
                cachedData.forEach(entry => {
                    if (entry.LedgerEntryType === "AccountRoot" && entry.Balance) {
                        state.set(entry.Account, entry);
                    }
                });
                return;
            }

            let marker = undefined;
            const ledgerState = [];

            do {
                try {
                    const response = await client.request({
                        command: "ledger_data",
                        ledger_index: ledgerIndex,
                        limit: 2048,
                        marker: marker,
                        binary: false,
                        api_version: 1
                    });

                    if (response.result.state) {
                        const filteredEntries = response.result.state.filter(entry =>
                            entry.LedgerEntryType === "AccountRoot" && entry.Balance
                        );

                        filteredEntries.forEach(entry => {
                            state.set(entry.Account, entry);
                            ledgerState.push(entry);
                        });

                        console.log(`Ledger ${ledgerIndex}: Fetched ${filteredEntries.length} accounts. Total unique: ${state.size}`);
                    }

                    marker = response.result.marker;
                } catch (error) {
                    console.error(`Error in ledger ${ledgerIndex}:`, error.message);
                    break;
                }
            } while (marker);

            fs.writeFileSync(ledgerFileName, JSON.stringify(ledgerState, null, 2));
            processedLedgers.add(ledgerIndex);
        }

        const batchSize = 5;
        const ledgerStep = 1000;
        const minimumLedger = 1;

        for (let currentLedger = latestLedgerIndex; currentLedger >= minimumLedger; currentLedger -= (ledgerStep * batchSize)) {
            const batchPromises = [];

            for (let i = 0; i < batchSize && (currentLedger - i * ledgerStep) >= minimumLedger; i++) {
                const ledgerToFetch = currentLedger - (i * ledgerStep);
                batchPromises.push(fetchFullLedger(ledgerToFetch));
            }

            await Promise.all(batchPromises);
            console.log(`Completed batch. Current unique accounts: ${state.size}`);
        }

    } catch (error) {
        console.error("Error:", error);
    } finally {
        await client.disconnect();
    }
}

main();
