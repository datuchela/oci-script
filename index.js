const core = require("oci-core");
const identity = require("oci-identity");
const common = require("oci-common");
require("dotenv").config();

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

// Script execution ---------------------
console.log("Starting script");
checkEnvVariables(requiredVars);
runCreateComputeInstanceInterval(RETRY_WAIT_SECONDS);
// --------------------------------------

function checkEnvVariables(requiredVars) {
	for (const [key, value] of Object.entries(requiredVars)) {
		if (value === null || value === undefined) {
			throw new Error(`${key} is not set in environmental variables`);
		}
	}
}

async function runCreateComputeInstanceInterval(interval) {
	for (; ;) {
		let date = new Date(Date.now());
		console.log(date.toLocaleString());
		try {
			await createComputeInstance();
			await waitWithTimer(interval);
		} catch (err) {
			console.error("Unhandled error:", err);
		}
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

async function createComputeInstance() {
	// Load the configuration from the default location (~/.oci/config)
	const provider = new common.ConfigFileAuthenticationDetailsProvider();

	const identityClient = new identity.IdentityClient({
		authenticationDetailsProvider: provider
	});

	const computeClient = new core.ComputeClient({
		authenticationDetailsProvider: provider
	});

	// Replace with your compartment OCID
	const compartmentId = OCI_COMPARTMENT_ID;

	try {
		// Get the list of availability domains
		const listAvailabilityDomainsResponse = await identityClient.listAvailabilityDomains({
			compartmentId: compartmentId
		});
		const availabilityDomains = listAvailabilityDomainsResponse.items;

		// Set up the necessary parameters for the instance creation
		const createVnicDetails = {
			assignPublicIp: true,
			subnetId: OCI_SUBNET_ID,
		};

		const launchInstanceDetailsTemplate = {
			compartmentId: compartmentId,
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
			createVnicDetails: createVnicDetails,
			metadata: {
				ssh_authorized_keys: SSH_KEY_PUB,
			}
		};

		for (const ad of availabilityDomains) {
			const launchInstanceDetails = {
				...launchInstanceDetailsTemplate,
				availabilityDomain: ad.name
			};

			try {
				const launchInstanceResponse = await computeClient.launchInstance({
					launchInstanceDetails: launchInstanceDetails
				});

				console.log(`Instance created successfully in ${ad.name}:`, launchInstanceResponse.instance);
				// If you only want to create one instance, break the loop after successful creation
				break;
			} catch (err) {
				if (err.serviceCode === "TooManyRequests") {
					console.error(`Too many requests. Waiting before retrying...`);
					await waitWithTimer(LONG_WAIT_SECONDS);
					return; // Exit the function to prevent scheduling another immediate call
				} else if (err.message === "Out of host capacity.") {
					console.log(err.message);
				} else {
					console.error(`Failed to create instance in ${ad.name}:`, err);
				}
			}
		}
	} catch (err) {
		console.error("Error fetching availability domains:", err);
	}
}
