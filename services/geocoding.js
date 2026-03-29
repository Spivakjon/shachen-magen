// services/geocoding.js — Geocoding + street autocomplete via Nominatim
import { logger } from '../core/logger.js';

const NOMINATIM_URL = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'ShachenMagen/1.0 (shelter-app)';

/**
 * Geocode address → lat/lng
 */
export async function geocodeAddress(address, city) {
  const parts = [address, city, 'ישראל'].filter(Boolean);
  const q = parts.join(', ');

  try {
    const res = await fetch(`${NOMINATIM_URL}?${new URLSearchParams({
      q, format: 'json', limit: '1', countrycodes: 'il',
    })}`, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'he' },
    });

    if (!res.ok) return null;
    const data = await res.json();
    if (!data?.length) return null;

    return {
      lat: parseFloat(data[0].lat),
      lng: parseFloat(data[0].lon),
      display_name: data[0].display_name,
    };
  } catch (err) {
    logger.debug({ err: err.message, address, city }, 'Geocoding failed');
    return null;
  }
}

/**
 * Search streets in a city — returns matching street names
 * Uses Nominatim structured search for street autocomplete
 */
export async function searchStreets(query, city) {
  if (!query || query.length < 2) return [];

  try {
    const res = await fetch(`${NOMINATIM_URL}?${new URLSearchParams({
      street: query,
      city: city || '',
      country: 'Israel',
      format: 'json',
      limit: '8',
      countrycodes: 'il',
      addressdetails: '1',
    })}`, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'he' },
    });

    if (!res.ok) return [];
    const data = await res.json();

    // Extract unique street names
    const seen = new Set();
    const results = [];
    for (const item of data) {
      const road = item.address?.road || item.address?.pedestrian || '';
      const houseNum = item.address?.house_number || '';
      const itemCity = item.address?.city || item.address?.town || item.address?.village || city || '';
      const street = houseNum ? `${road} ${houseNum}` : road;

      if (!road || seen.has(street)) continue;
      seen.add(street);

      results.push({
        street,
        road,
        houseNumber: houseNum,
        city: itemCity,
        full: `${street}, ${itemCity}`,
        lat: parseFloat(item.lat),
        lng: parseFloat(item.lon),
      });
    }
    return results;
  } catch {
    return [];
  }
}
