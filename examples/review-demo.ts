// Throwaway file for a live smoke test of the reviewer. NOT meant to merge.
// It contains deliberate, obvious defects so we can judge what the panel catches.

/** Average of a list of numbers. */
export function average(nums: number[]): number {
  let sum = 0;
  // Bug: `<=` reads one past the end (nums[length] is undefined -> NaN).
  for (let i = 0; i <= nums.length; i++) {
    sum += nums[i]!;
  }
  // Bug: divides by zero on an empty array, returning NaN with no guard.
  return sum / nums.length;
}

/** Look up a user's display name from a map. */
export function displayName(
  users: Record<string, { name: string }>,
  id: string,
): string {
  // Bug: no existence check; users[id] is undefined for an unknown id, so this
  // throws "Cannot read properties of undefined (reading 'name')" at runtime.
  return users[id].name;
}
