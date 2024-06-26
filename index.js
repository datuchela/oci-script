const core = require("oci-core");
const identity = require("oci-identity");
const common = require("oci-common");
require("dotenv").config();

const AD_REQ_INTERVAL_SECONDS = process.env.AD_REQ_INTERVAL_SECONDS ?? 5;
const RETRY_WAIT_SECONDS = process.env.RETRY_WAIT_SECONDS ?? 64;
const LONG_WAIT_MINUTES = process.env.LONG_WAIT_MINUTES ?? 10;
const LONG_WAIT_SECONDS = LONG_WAIT_MINUTES * 60;

const DISPLAY_NAME = process.env.DISPLAY_NAME ?? "myOciInstance";
const OCI_SHAPE = process.env.OCI_SHAPE ?? "VM.Standard.A1.Flex";
const OCI_OCPUS = process.env.OCI_OCPUS ?? 4;
const OCI_MEMORY_IN_GBS = process.env.OCI_MEMORY_IN_GBS ?? 24;
const OCI_IMAGE_ID = process.env.OCI_IMAGE_ID;
const OCI_COMPARTMENT_ID = process.env.OCI_COMPARTMENT_ID;
const OCI_SUBNET_ID = process.env.OCI_SUBNET_ID;
const SSH_KEY_PUB = process.env.SSH_KEY_PUB;

const requiredVars = {
	OCI_IMAGE_ID,
	OCI_COMPARTMENT_ID,
	OCI_SUBNET_ID,
	SSH_KEY_PUB,
};

const optionalVars = {
	AD_REQ_INTERVAL_SECONDS: process.env.AD_REQ_INTERVAL_SECONDS,
	RETRY_WAIT_SECONDS: process.env.RETRY_WAIT_SECONDS,
	LONG_WAIT_MINUTES: process.env.LONG_WAIT_MINUTES,
	DISPLAY_NAME: process.env.DISPLAY_NAME,
	OCI_SHAPE: process.env.OCI_SHAPE,
	OCI_OCPUS: process.env.OCI_OCPUS,
	OCI_MEMORY_IN_GBS: process.env.OCI_MEMORY_IN_GBS,
}

function checkEnvVariables(requiredVars, optional) {
	console.log(`[INFO] Checking ${optional ? "optional" : "required"} environment variables...`);
	for (const [key, value] of Object.entries(requiredVars)) {
		console.log(`${key}=${value}`);
		if (value === null || value === undefined) {
			if (!optional) {
				throw new Error(`${key} is not set in environment variables`);
			}
			console.warn(`[WARN] ${key} is not set in environment variables, default value will be used`);
		}
	}
	console.log("[INFO] Done");
}

async function createComputeInstance(computeClient, availabilityDomains) {
	try {

		const launchInstanceDetailsTemplate = {
			compartmentId: OCI_COMPARTMENT_ID,
			shape: OCI_SHAPE,
			shapeConfig: {
				ocpus: OCI_OCPUS,
				memoryInGBs: OCI_MEMORY_IN_GBS,
			},
			displayName: DISPLAY_NAME,
			sourceDetails: {
				sourceType: "image",
				imageId: OCI_IMAGE_ID,
			},
			createVnicDetails: {
				assignPublicIp: true,
				subnetId: OCI_SUBNET_ID,
			},
			metadata: {
				ssh_authorized_keys: SSH_KEY_PUB,
			},
		};

		for (const ad of availabilityDomains) {
			const launchInstanceDetails = {
				...launchInstanceDetailsTemplate,
				availabilityDomain: ad.name
			};

			try {
				const launchInstanceResponse = await computeClient.launchInstance({
					launchInstanceDetails: launchInstanceDetails,
				});
				console.log(`[SUCCESS] Instance created successfully in ${ad.name}:`, launchInstanceResponse.instance);
				break;
			} catch (err) {
				if (err.serviceCode === "TooManyRequests") {
					console.error(`[WARN] Too many requests. Waiting before retrying...`);
					await waitWithTimer(LONG_WAIT_SECONDS);
					return; // Exit the function to prevent scheduling another immediate call
				} else if (err.message === "Out of host capacity.") {
					console.log("[INFO] Out of host capacity.");
					await waitWithTimer(AD_REQ_INTERVAL_SECONDS);
				} else {
					console.error(`Failed to create instance in ${ad.name}:`, err);
				}
			}
		}
	} catch (err) {
		console.error("Error fetching availability domains:", err);
	}
}

async function waitWithTimer(seconds) {
	return new Promise((resolve) => {
		let timer = 0;

		const interval = setInterval(() => {
			if (timer <= seconds) {
				process.stdout.write(`Waiting for ${timer}/${seconds} seconds...\r`);
				timer += 1;
			} else {
				clearInterval(interval);
				process.stdout.write('\n'); // Move to the next line after the timer ends
				resolve();
			}
		}, 1000);
	});
}

async function runCreateComputeInstanceInterval(createComputeInstanceProps, interval) {
	for (; ;) {
		let date = new Date(Date.now());
		console.log(`[INFO] ${date.toLocaleString()}`);
		try {
			await createComputeInstance(...createComputeInstanceProps);
			console.log("Retrying after the interval");
			await waitWithTimer(interval);
		} catch (err) {
			console.error("[ERROR] Unhandled error:", err);
		}
	}
}

// Script start (main)
(async () => {
	try {
		console.log("Starting script");
		checkEnvVariables(requiredVars);
		checkEnvVariables(optionalVars, true);

		// Load the configuration from the default location (~/.oci/config)
		const provider = new common.ConfigFileAuthenticationDetailsProvider();

		const identityClient = new identity.IdentityClient({
			authenticationDetailsProvider: provider
		});

		const computeClient = new core.ComputeClient({
			authenticationDetailsProvider: provider
		});

		const listAvailabilityDomainsResponse = await identityClient.listAvailabilityDomains({
			compartmentId: OCI_COMPARTMENT_ID
		});
		const availabilityDomains = listAvailabilityDomainsResponse.items;

		const createComputeInstanceParams = [
			computeClient,
			availabilityDomains,
		];

		console.log(`Running runCreateComputeInstanceInterval with ${RETRY_WAIT_SECONDS}s interval`);
		runCreateComputeInstanceInterval(createComputeInstanceParams, RETRY_WAIT_SECONDS);
	} catch (err) {
		throw new Error(err);
	}
})();

