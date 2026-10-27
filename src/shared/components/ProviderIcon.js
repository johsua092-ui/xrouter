"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { getProviderIconSrc, markProviderIconMissing } from "@/shared/utils/providerIcon";

import CustomCompatibleIcon from "@/shared/components/CustomCompatibleIcon";

function resolveSrc(src, providerId) {
  if (src) return src;
  if (providerId) return getProviderIconSrc(providerId);
  return null;
}

export default function ProviderIcon({
  src,
  providerId,
  alt,
  size = 32,
  className = "",
  fallbackText = "?",
  fallbackColor,
}) {
  const effectiveSrc = resolveSrc(src, providerId);
  const [errored, setErrored] = useState(false);

  // If this is a custom compatible provider, render the native theme-reactive vector
  if (/custom-openai/i.test(effectiveSrc)) {
    return <CustomCompatibleIcon variant="openai" size={size} className={className} />;
  }
  if (/custom-anthropic/i.test(effectiveSrc)) {
    return <CustomCompatibleIcon variant="anthropic" size={size} className={className} />;
  }
  if (/custom-moonshot/i.test(effectiveSrc)) {
    return <CustomCompatibleIcon variant="moonshot" size={size} className={className} />;
  }

  if (!effectiveSrc || errored) {
    return (
      <span
        className={`inline-flex items-center justify-center font-bold rounded-lg ${className}`.trim()}
        style={{
          width: size,
          height: size,
          color: fallbackColor,
          fontSize: Math.max(10, Math.floor(size * 0.38)),
        }}
      >
        {fallbackText}
      </span>
    );
  }

  const isCustomCompatible = /custom-(openai|anthropic|moonshot)/i.test(effectiveSrc);

  return (
    <img
      src={effectiveSrc}
      alt={alt}
      width={size}
      height={size}
      className={`object-contain ${isCustomCompatible ? "" : /oai-cc|oai-r|openai|github/i.test(effectiveSrc) ? "dark:invert" : ""} ${className}`.trim()}
      style={{
        filter: isCustomCompatible ? "var(--logo-filter, none)" : undefined,
      }}
      loading="eager"
      onError={() => {
        const m = effectiveSrc.match(/^\/providers\/([^/]+)\.png$/i);
        if (m) markProviderIconMissing(m[1]);
        if (providerId) markProviderIconMissing(providerId);
        setErrored(true);
      }}
    />
  );
}

ProviderIcon.propTypes = {
  src: PropTypes.string,
  providerId: PropTypes.string,
  alt: PropTypes.string,
  size: PropTypes.number,
  className: PropTypes.string,
  fallbackText: PropTypes.string,
  fallbackColor: PropTypes.string,
};
