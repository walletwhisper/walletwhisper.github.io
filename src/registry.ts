import { BankProfile } from './types.js';
import { chaseCreditProfile } from './profiles/chaseCredit.js';
import { chaseCheckingProfile } from './profiles/chaseChecking.js';

class BankRegistry {
  private profiles: BankProfile[] = [];

  constructor() {
    this.register(chaseCreditProfile);
    this.register(chaseCheckingProfile);
  }

  register(profile: BankProfile) {
    this.profiles.push(profile);
  }

  detect(headers: string[]): BankProfile | null {
    for (const profile of this.profiles) {
      if (profile.matches(headers)) {
        return profile;
      }
    }
    return null;
  }

  getProfile(id: string): BankProfile | undefined {
    return this.profiles.find(p => p.id === id);
  }

  listProfiles(): BankProfile[] {
    return [...this.profiles];
  }
}

export const bankRegistry = new BankRegistry();
