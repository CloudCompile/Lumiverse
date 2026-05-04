export async function checkUsernameAvailability(username: string): Promise<{ available: boolean; error?: string }> {
  try {
    const response = await fetch(`/api/auth/signup/check-username?username=${encodeURIComponent(username)}`);
    return await response.json();
  } catch (err) {
    return { available: false, error: "Failed to check username" };
  }
}

export async function checkEmailAvailability(email: string): Promise<{ available: boolean; error?: string }> {
  try {
    const response = await fetch(`/api/auth/signup/check-email?email=${encodeURIComponent(email)}`);
    return await response.json();
  } catch (err) {
    return { available: false, error: "Failed to check email" };
  }
}

export async function signup(username: string, email: string, password: string): Promise<any> {
  const response = await fetch("/api/auth/signup/public", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, email, password }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Signup failed");
  }

  return data;
}
